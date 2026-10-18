import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { NotificationJob, NotificationJobDocument } from './schemas/notification-job.schema';
import {
  NO_RECIPIENT_PLACEHOLDER,
  NotificationEventType,
  NotificationStatus,
  ZALO_BOT_CHANNEL,
} from './zalo-bot.constants';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotCallResult, ZaloBotClient, ZaloSendMessageResult } from './zalo-bot.client';
import { ZaloOwnerRecipientService, maskChatId } from './zalo-owner-recipient.service';
import { formatOrderCreatedMessage, orderDisplayCode, OrderMessageInput } from './order-message.formatter';
import { AuditService } from '../audit/audit.service';
import { ZbsOrderConfirmationService } from '../zalo-zbs/zbs-order-confirmation.service';

/** Name of the outbox field on Order (see order.schema.ts `pendingNotificationEvents`). */
export const ORDER_OUTBOX_FIELD = 'pendingNotificationEvents';

const FAN_OUT_BATCH = 20;
const SEND_BATCH = 10;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_ERROR_MESSAGE_LENGTH = 500;

export function notificationDedupKey(eventType: NotificationEventType, orderId: string, recipientId: string): string {
  return `${eventType}:${ZALO_BOT_CHANNEL}:${orderId}:${recipientId}`;
}

/** Exponential backoff: base, 2×base, 4×base … capped at 30 min. `attempt` is 1-based. */
export function retryDelayMs(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

export interface RunOnceResult {
  recovered: number;
  fannedOut: number;
  processed: number;
}

/**
 * ORDER_CREATED → Zalo Bot pipeline (transactional outbox without Mongo transactions):
 *
 *  1. OrdersService.create() writes `pendingNotificationEvents: ['ORDER_CREATED']` INSIDE the
 *     new order document. A single-document insert is atomic, so the intent exists iff the
 *     order exists — a failed checkout can never leave a notification behind, and a crash
 *     right after checkout can't lose one.
 *  2. The worker fans each flagged order out into one NotificationJob per approved recipient
 *     (unique `dedupKey` → duplicate events / concurrent workers can't create a 2nd job),
 *     then pulls the flag.
 *  3. Jobs are claimed with an atomic findOneAndUpdate lease, sent via ZaloBotClient, and the
 *     outcome is persisted. TRANSIENT failures back off exponentially; UNKNOWN outcomes are
 *     parked for a human — never blindly resent.
 *
 * This service is also the single ORDER_CREATED entry point for checkout: it adds the
 * customer ZBS channel's own outbox marker and forwards `kick()` to its (separate) worker —
 * see src/zalo-zbs. Each channel only claims its own jobs (`channel` filter).
 *
 * Nothing here runs inside the checkout request: OrdersService only gets a non-blocking
 * `kick()`. Render runs this backend as a long-lived process, so a setInterval worker is
 * appropriate (no serverless constraints); the lease makes multiple instances safe.
 */
@Injectable()
export class OrderNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderNotificationService.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<RunOnceResult> | null = null;

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(NotificationJob.name) private readonly jobModel: Model<NotificationJobDocument>,
    private readonly configService: ZaloBotConfigService,
    private readonly client: ZaloBotClient,
    private readonly recipients: ZaloOwnerRecipientService,
    private readonly auditService: AuditService,
    /** Customer ZBS confirmation (optional so the Bot works — and is tested — on its own). */
    @Optional() private readonly zbs?: ZbsOrderConfirmationService,
  ) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  onModuleInit(): void {
    const cfg = this.configService.get();
    if (!cfg.enabled) {
      this.logger.log('Zalo Bot: ZALO_BOT_ENABLED=false — thông báo đơn hàng đang tắt');
      return;
    }
    const v = this.configService.validate(cfg);
    if (v.errors.length) this.logger.error(`Zalo Bot cấu hình không hợp lệ: ${v.errors.join('; ')}`);
    v.warnings.forEach((w) => this.logger.warn(`Zalo Bot: ${w}`));
    if (cfg.workerIntervalMs > 0) {
      this.timer = setInterval(() => this.kick(), cfg.workerIntervalMs);
      this.timer.unref();
      this.logger.log(`Zalo Bot worker ${this.workerId} chạy mỗi ${cfg.workerIntervalMs}ms`);
    }
    // Pick up anything left over from before a restart / Render spin-down.
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Producer side (called from OrdersService) ──────────────────────────

  /** Extra fields to merge into a new customer order so the intent is persisted atomically
   * with it: 'ORDER_CREATED' for the owner Bot, plus the ZBS marker for the customer
   * confirmation — each only while its own channel is enabled. Empty when both are off —
   * checkout behaves exactly as before. */
  orderCreatedOutboxFields(): { pendingNotificationEvents?: string[] } {
    const events: string[] = [];
    try {
      if (this.configService.get().enabled) events.push(NotificationEventType.ORDER_CREATED);
    } catch (err) {
      this.logger.error(`Không xác định được cấu hình Zalo Bot: ${(err as Error).message}`);
    }
    const zbsMarker = this.zbs?.outboxMarker();
    if (zbsMarker) events.push(zbsMarker);
    return events.length ? { [ORDER_OUTBOX_FIELD]: events } : {};
  }

  /** Fire-and-forget nudge so the owner is notified within seconds instead of at the next
   * poll. Never throws, never awaits Zalo. */
  kick(): void {
    this.zbs?.kick();
    try {
      if (!this.configService.get().enabled) return;
    } catch {
      return;
    }
    setImmediate(() => {
      this.runOnce().catch((err) => this.logger.error(`Zalo Bot worker lỗi: ${(err as Error).message}`));
    });
  }

  // ─── Worker ──────────────────────────────────────────────────────────────

  /** One worker pass. Concurrent calls in the same process share a single pass; other
   * processes are kept apart by the unique dedupKey + job lease. */
  runOnce(): Promise<RunOnceResult> {
    if (!this.inFlight) {
      this.inFlight = this.doRunOnce().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRunOnce(): Promise<RunOnceResult> {
    const recovered = await this.recoverStaleJobs();
    const fannedOut = await this.fanOutPendingOrders();
    let processed = 0;
    for (let i = 0; i < SEND_BATCH; i++) {
      const job = await this.claimNextJob();
      if (!job) break;
      await this.processJob(job);
      processed++;
    }
    return { recovered, fannedOut, processed };
  }

  async fanOutPendingOrders(limit = FAN_OUT_BATCH): Promise<number> {
    const event = NotificationEventType.ORDER_CREATED;
    // Soft-deleted orders are hidden by the Order find() hook — just drop their flag.
    await this.orderModel
      .updateMany({ [ORDER_OUTBOX_FIELD]: event, isDeleted: true }, { $pull: { [ORDER_OUTBOX_FIELD]: event } })
      .exec();

    const orders = await this.orderModel
      .find({ [ORDER_OUTBOX_FIELD]: event })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    for (const order of orders) {
      await this.fanOutOrder(order._id.toString(), event);
      await this.orderModel.updateOne({ _id: order._id }, { $pull: { [ORDER_OUTBOX_FIELD]: event } }).exec();
    }
    return orders.length;
  }

  /** Creates one job per approved recipient (idempotent). With no valid config/recipient it
   * records a single SKIPPED_NOT_CONFIGURED placeholder instead, so the gap is visible. */
  async fanOutOrder(orderId: string, eventType: NotificationEventType): Promise<{ jobs: number; skipped: boolean }> {
    const cfg = this.configService.get();
    const validation = this.configService.validate(cfg);
    const approved = validation.valid ? await this.recipients.getApprovedRecipients() : [];
    const orderCode = orderDisplayCode(orderId);
    const orderObjectId = new Types.ObjectId(orderId);

    if (!validation.valid || !approved.length) {
      const reason = !cfg.enabled ? 'BOT_DISABLED' : !validation.valid ? 'CONFIG_INVALID' : 'NO_APPROVED_RECIPIENT';
      const message = !validation.valid
        ? validation.errors.join('; ') || 'Zalo Bot chưa được bật'
        : 'Chưa có chat id chủ shop nào được duyệt (ZALO_OWNER_CHAT_IDS / duyệt trong admin)';
      await this.upsertJob({
        dedupKey: notificationDedupKey(eventType, orderId, NO_RECIPIENT_PLACEHOLDER),
        channel: ZALO_BOT_CHANNEL,
        eventType,
        orderId: orderObjectId,
        orderCode,
        recipientId: NO_RECIPIENT_PLACEHOLDER,
        status: NotificationStatus.SKIPPED_NOT_CONFIGURED,
        maxAttempts: 0,
        lastErrorCode: reason,
        lastErrorMessage: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        processedAt: new Date(),
      });
      this.logger.warn(`Đơn ${orderCode}: bỏ qua thông báo Zalo (${reason})`);
      return { jobs: 0, skipped: true };
    }

    for (const r of approved) {
      await this.upsertJob({
        dedupKey: notificationDedupKey(eventType, orderId, r.chatId),
        channel: ZALO_BOT_CHANNEL,
        eventType,
        orderId: orderObjectId,
        orderCode,
        recipientId: r.chatId,
        recipientSource: r.source,
        ...(r.label ? { recipientLabel: r.label } : {}),
        status: NotificationStatus.PENDING,
        maxAttempts: cfg.maxRetries + 1,
        nextAttemptAt: new Date(),
      });
    }
    // A real fan-out supersedes an earlier "not configured" placeholder for this order.
    await this.jobModel
      .deleteOne({
        dedupKey: notificationDedupKey(eventType, orderId, NO_RECIPIENT_PLACEHOLDER),
        status: NotificationStatus.SKIPPED_NOT_CONFIGURED,
      })
      .exec();
    return { jobs: approved.length, skipped: false };
  }

  private async upsertJob(fields: Partial<NotificationJob> & { dedupKey: string }): Promise<void> {
    try {
      await this.jobModel
        .updateOne({ dedupKey: fields.dedupKey }, { $setOnInsert: { attemptCount: 0, attempts: [], ...fields } }, { upsert: true })
        .exec();
    } catch (err) {
      // Two workers upserting the same key at once: the unique index rejects the loser.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /** A PROCESSING job whose lease ran out belongs to a worker that died mid-send. Zalo may
   * or may not have received it, so it becomes UNKNOWN (manual check), never auto-resent. */
  async recoverStaleJobs(): Promise<number> {
    const now = new Date();
    const res = await this.jobModel
      .updateMany(
        { channel: ZALO_BOT_CHANNEL, status: NotificationStatus.PROCESSING, lockedUntil: { $lt: now } },
        {
          $set: {
            status: NotificationStatus.UNKNOWN,
            lastErrorCode: 'WORKER_LEASE_EXPIRED',
            lastErrorMessage: 'Worker dừng giữa chừng khi đang gửi — không rõ Zalo đã nhận hay chưa',
            processedAt: now,
          },
          $unset: { lockedUntil: 1, lockOwner: 1 },
        },
      )
      .exec();
    if (res.modifiedCount) this.logger.warn(`Zalo Bot: ${res.modifiedCount} job hết lease → UNKNOWN`);
    return res.modifiedCount;
  }

  async claimNextJob(): Promise<NotificationJobDocument | null> {
    const now = new Date();
    const leaseMs = this.configService.get().requestTimeoutMs + 30_000;
    return this.jobModel
      .findOneAndUpdate(
        {
          channel: ZALO_BOT_CHANNEL,
          status: { $in: [NotificationStatus.PENDING, NotificationStatus.RETRY_PENDING] },
          nextAttemptAt: { $lte: now },
        },
        {
          $set: {
            status: NotificationStatus.PROCESSING,
            lockOwner: this.workerId,
            lockedUntil: new Date(now.getTime() + leaseMs),
          },
          $inc: { attemptCount: 1 },
        },
        { sort: { nextAttemptAt: 1 }, new: true },
      )
      .exec();
  }

  async processJob(job: NotificationJobDocument): Promise<NotificationStatus> {
    const cfg = this.configService.get();
    let sendStarted = false;
    try {
      if (!(await this.recipients.isApproved(job.recipientId))) {
        return this.finalize(job, NotificationStatus.SKIPPED_NOT_CONFIGURED, {
          errorCode: 'RECIPIENT_NOT_APPROVED',
          errorMessage: 'Người nhận không còn trong danh sách được duyệt',
          outcome: 'SKIPPED',
        });
      }
      const order = await this.orderModel.findById(job.orderId).lean().exec();
      if (!order) {
        return this.finalize(job, NotificationStatus.FAILED, {
          errorCode: 'ORDER_NOT_FOUND',
          errorMessage: 'Đơn hàng không còn tồn tại (đã xóa?)',
          outcome: 'PERMANENT',
        });
      }

      const text = formatOrderCreatedMessage(order as unknown as OrderMessageInput, { adminUrl: cfg.adminUrl });
      sendStarted = true;
      const res = await this.client.sendMessage(job.recipientId, text);
      return this.applySendResult(job, res, cfg.retryBaseDelayMs);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`Zalo Bot job ${job._id}: lỗi ngoài dự kiến — ${message}`);
      if (sendStarted) {
        // We can't tell whether Zalo got it; let the lease expire into UNKNOWN rather than
        // risk a duplicate. (Usually this means the DB write after the send failed.)
        return NotificationStatus.PROCESSING;
      }
      const canRetry = job.attemptCount < job.maxAttempts;
      return this.finalize(job, canRetry ? NotificationStatus.RETRY_PENDING : NotificationStatus.FAILED, {
        errorCode: 'INTERNAL_ERROR',
        errorMessage: message,
        outcome: 'INTERNAL',
        nextAttemptAt: canRetry ? new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, job.attemptCount)) : undefined,
      });
    }
  }

  private async applySendResult(
    job: NotificationJobDocument,
    res: ZaloBotCallResult<ZaloSendMessageResult>,
    retryBaseDelayMs: number,
  ): Promise<NotificationStatus> {
    if (res.ok) {
      const messageId = res.result?.message_id ? String(res.result.message_id) : undefined;
      this.logger.log(
        `Zalo Bot: đã gửi thông báo đơn ${job.orderCode} tới ${maskChatId(job.recipientId)} (message_id ${messageId ?? '-'})`,
      );
      return this.finalize(job, NotificationStatus.ACCEPTED, {
        providerMessageId: messageId,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        outcome: 'ACCEPTED',
      });
    }

    const common = {
      errorCode: res.errorCode,
      errorMessage: res.description,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      outcome: res.errorClass,
    };
    switch (res.errorClass) {
      case 'TRANSIENT':
        if (job.attemptCount < job.maxAttempts) {
          const delay = retryDelayMs(retryBaseDelayMs, job.attemptCount);
          return this.finalize(job, NotificationStatus.RETRY_PENDING, {
            ...common,
            nextAttemptAt: new Date(Date.now() + delay),
          });
        }
        return this.finalize(job, NotificationStatus.FAILED, common);
      case 'UNKNOWN':
        return this.finalize(job, NotificationStatus.UNKNOWN, common);
      case 'CONFIG':
        return this.finalize(job, NotificationStatus.SKIPPED_NOT_CONFIGURED, common);
      case 'PERMANENT':
      case 'VALIDATION':
      default:
        return this.finalize(job, NotificationStatus.FAILED, common);
    }
  }

  /** Persists the outcome — only if this worker still owns the lease. */
  private async finalize(
    job: NotificationJobDocument,
    status: NotificationStatus,
    info: {
      outcome: string;
      errorCode?: string;
      errorMessage?: string;
      httpStatus?: number;
      durationMs?: number;
      providerMessageId?: string;
      nextAttemptAt?: Date;
    },
  ): Promise<NotificationStatus> {
    const now = new Date();
    const terminal = status !== NotificationStatus.RETRY_PENDING;
    const $set: Record<string, unknown> = { status };
    const $unset: Record<string, 1> = { lockedUntil: 1, lockOwner: 1 };

    if (status === NotificationStatus.ACCEPTED) {
      $set.acceptedAt = now;
      $unset.lastErrorCode = 1;
      $unset.lastErrorMessage = 1;
      if (info.providerMessageId) $set.providerMessageId = info.providerMessageId;
    } else {
      if (info.errorCode) $set.lastErrorCode = info.errorCode;
      if (info.errorMessage) $set.lastErrorMessage = info.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    }
    if (info.httpStatus !== undefined) $set.lastHttpStatus = info.httpStatus;
    if (info.nextAttemptAt) $set.nextAttemptAt = info.nextAttemptAt;
    if (terminal) $set.processedAt = now;

    const attempt = {
      at: now,
      outcome: info.outcome,
      ...(info.errorCode ? { errorCode: info.errorCode } : {}),
      ...(info.httpStatus !== undefined ? { httpStatus: info.httpStatus } : {}),
      ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
    };

    const res = await this.jobModel
      .updateOne(
        { _id: job._id, status: NotificationStatus.PROCESSING, lockOwner: this.workerId },
        { $set, $unset, $push: { attempts: { $each: [attempt], $slice: -10 } } },
      )
      .exec();
    if (!res.modifiedCount) {
      this.logger.warn(`Zalo Bot job ${job._id}: mất lease trước khi lưu kết quả ${status}`);
    } else if (status !== NotificationStatus.ACCEPTED) {
      this.logger.warn(
        `Zalo Bot: đơn ${job.orderCode} → ${maskChatId(job.recipientId)}: ${status} (${info.errorCode ?? '-'})`,
      );
    }
    return status;
  }

  // ─── Admin operations ────────────────────────────────────────────────────

  async listJobs(query: { status?: NotificationStatus; orderId?: string; page: number; limit: number }) {
    const filter: Record<string, unknown> = { channel: ZALO_BOT_CHANNEL };
    if (query.status) filter.status = query.status;
    if (query.orderId) {
      if (!Types.ObjectId.isValid(query.orderId)) throw new BadRequestException('orderId không hợp lệ');
      filter.orderId = new Types.ObjectId(query.orderId);
    }
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const [rows, total] = await Promise.all([
      this.jobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.jobModel.countDocuments(filter).exec(),
    ]);
    return {
      data: rows.map((j) => ({
        _id: j._id.toString(),
        orderId: j.orderId.toString(),
        orderCode: j.orderCode,
        channel: j.channel,
        eventType: j.eventType,
        recipient: j.recipientId === NO_RECIPIENT_PLACEHOLDER ? null : maskChatId(j.recipientId),
        recipientSource: j.recipientSource,
        recipientLabel: j.recipientLabel,
        status: j.status,
        attemptCount: j.attemptCount,
        maxAttempts: j.maxAttempts,
        nextAttemptAt: j.nextAttemptAt,
        providerMessageId: j.providerMessageId,
        lastErrorCode: j.lastErrorCode,
        lastErrorMessage: j.lastErrorMessage,
        lastHttpStatus: j.lastHttpStatus,
        attempts: j.attempts,
        acceptedAt: j.acceptedAt,
        processedAt: j.processedAt,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        retryable: this.isRetryable(j.status),
      })),
      total,
      page,
      limit,
    };
  }

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await this.jobModel
      .aggregate<{ _id: string; count: number }>([
        { $match: { channel: ZALO_BOT_CHANNEL } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }

  private isRetryable(status: NotificationStatus): boolean {
    return [NotificationStatus.FAILED, NotificationStatus.UNKNOWN, NotificationStatus.SKIPPED_NOT_CONFIGURED].includes(
      status,
    );
  }

  /**
   * Manual retry (admin). Grants exactly ONE more attempt — no runaway loops. An UNKNOWN job
   * requires `confirmUnknownOutcome` (the admin checked Zalo and the message did not arrive),
   * because resending it may otherwise duplicate a delivered message.
   */
  async retryJob(id: string, staffId: string, confirmUnknownOutcome = false) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Mã thông báo không hợp lệ');
    const job = await this.jobModel.findById(id).exec();
    // ZBS rows share the collection; they are retried via /admin/zalo-zbs only.
    if (!job || job.channel !== ZALO_BOT_CHANNEL) throw new NotFoundException('Không tìm thấy thông báo');
    if (!this.isRetryable(job.status)) {
      throw new BadRequestException(`Không thể gửi lại thông báo ở trạng thái ${job.status}`);
    }
    if (job.status === NotificationStatus.UNKNOWN && !confirmUnknownOutcome) {
      throw new BadRequestException(
        'Kết quả lần gửi trước không xác định — hãy kiểm tra Zalo của chủ shop trước. Gửi lại có thể bị trùng tin; xác nhận bằng confirmUnknownOutcome=true',
      );
    }

    let result: { mode: 'requeued' | 'fanned_out'; jobs?: number };
    if (job.recipientId === NO_RECIPIENT_PLACEHOLDER) {
      const v = this.configService.validate();
      const approved = v.valid ? await this.recipients.getApprovedRecipients() : [];
      if (!v.valid || !approved.length) {
        throw new BadRequestException(
          v.valid ? 'Chưa có người nhận nào được duyệt' : `Cấu hình Zalo Bot chưa hợp lệ: ${v.errors.join('; ')}`,
        );
      }
      const fan = await this.fanOutOrder(job.orderId.toString(), job.eventType);
      result = { mode: 'fanned_out', jobs: fan.jobs };
    } else {
      const res = await this.jobModel
        .updateOne(
          { _id: job._id, status: job.status },
          {
            $set: {
              status: NotificationStatus.RETRY_PENDING,
              nextAttemptAt: new Date(),
              maxAttempts: job.attemptCount + 1,
            },
            $unset: { processedAt: 1 },
          },
        )
        .exec();
      if (!res.modifiedCount) throw new BadRequestException('Thông báo vừa được cập nhật bởi tiến trình khác, thử lại sau');
      result = { mode: 'requeued' };
    }

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'ZALO_BOT_NOTIFICATION_RETRY',
      module: 'zalo-bot',
      targetId: id,
      beforeData: { status: job.status, attemptCount: job.attemptCount },
      afterData: { ...result, confirmUnknownOutcome },
    });
    this.kick();
    return result;
  }

  /** Fixed-text test message to an already-approved recipient (activation step J). */
  async sendTestMessage(recipientKey: string, staffId: string) {
    const recipient = await this.recipients.resolveApprovedKey(recipientKey);
    const text = `LUXE GLOW — Tin nhắn kiểm tra kết nối Zalo Bot (${new Date().toISOString()}). Nếu bạn nhận được tin này, thông báo đơn hàng mới sẽ được gửi tới đây.`;
    const res = await this.client.sendMessage(recipient.chatId, text);
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'ZALO_BOT_TEST_MESSAGE',
      module: 'zalo-bot',
      targetId: recipientKey,
      afterData: res.ok ? { ok: true } : { ok: false, errorCode: res.errorCode, errorClass: res.errorClass },
    });
    return res.ok
      ? { ok: true, providerMessageId: res.result?.message_id ?? null, recipient: maskChatId(recipient.chatId) }
      : {
          ok: false,
          errorClass: res.errorClass,
          errorCode: res.errorCode,
          description: res.description,
          recipient: maskChatId(recipient.chatId),
        };
  }
}
