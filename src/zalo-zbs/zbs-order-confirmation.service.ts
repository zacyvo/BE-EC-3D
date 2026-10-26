import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { Order, OrderDocument, OrderStatus } from '../orders/schemas/order.schema';
import { NotificationJob, NotificationJobDocument } from '../zalo-bot/schemas/notification-job.schema';
import { NotificationEventType, NotificationStatus } from '../zalo-bot/zalo-bot.constants';
import { orderDisplayCode } from '../zalo-bot/order-message.formatter';
import { AuditService } from '../audit/audit.service';
import { ZaloZbsConfigService, ZaloZbsConfigSnapshot } from './zalo-zbs.config';
import { ZbsApiClient, ZbsCallResult, ZbsSendData } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { maskZbsPhone, normalizeVnPhone } from './zbs-phone';
import { buildTrackingId, mapOrderToTemplateData, ZbsOrderInput } from './zbs-template.mapper';
import { toInt, ZbsTemplateGate, ZbsTemplateService, ZbsTemplateTarget, ZbsTemplateVerifyResult } from './zbs-template.service';
import {
  ZALO_ZBS_CHANNEL,
  ZBS_NO_RECIPIENT,
  ZBS_ORDER_OUTBOX_MARKER,
  ZBS_TEMPLATE_ORDER_CONFIRMATION,
  ZBS_TEMPLATE_UNUSABLE_CODES,
  ZbsErrorClass,
} from './zalo-zbs.constants';

const FAN_OUT_BATCH = 20;
const SEND_BATCH = 10;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const VN_OFFSET_MS = 7 * 3600 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
/** Same field as the Bot outbox (order.schema.ts). Not imported from order-notification.service
 * to keep the module dependency one-way (zalo-bot → zalo-zbs). */
const ORDER_OUTBOX_FIELD = 'pendingNotificationEvents';

/** Exponential backoff: base, 2×base, 4×base … capped at 30 min. `attempt` is 1-based. */
export function retryDelayMs(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

export function zbsDedupKey(orderId: string): string {
  return `${NotificationEventType.ORDER_CREATED}:${ZALO_ZBS_CHANNEL}:${orderId}:${ZBS_TEMPLATE_ORDER_CONFIRMATION}`;
}

/** Start of the current Vietnam calendar day/month, as a UTC Date. */
export function vnPeriodStart(now: Date, period: 'day' | 'month'): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const start = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), period === 'day' ? vn.getUTCDate() : 1);
  return new Date(start - VN_OFFSET_MS);
}

/** Next 07:05 Vietnam time — for Zalo's "no sending 22h–7h" rejection (-133). */
export function nextVnMorning(now: Date): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const today0705 = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), 7, 5) - VN_OFFSET_MS;
  if (vn.getUTCHours() < 7) return new Date(today0705);
  if (vn.getUTCHours() >= 22) return new Date(today0705 + 24 * 3600 * 1000);
  return new Date(now.getTime() + 30 * 60 * 1000);
}

export interface ZbsRunOnceResult {
  recovered: number;
  fannedOut: number;
  processed: number;
}

/**
 * ORDER_CREATED → customer "order received" message via ZBS Template Message (phone number).
 *
 * Reuses the owner Bot's infrastructure rather than duplicating it:
 *  - the same transactional outbox on Order (`pendingNotificationEvents`), with its own
 *    marker written by checkout only while ZALO_ZBS_ENABLED=true — orders created while ZBS
 *    was off are never back-filled;
 *  - the same `notification_jobs` collection (channel ZALO_ZBS) as queue + history, the same
 *    lease / backoff / UNKNOWN-is-never-auto-resent rules.
 * It runs its own worker so a slow or failing ZBS API can never delay or break the Bot.
 *
 * At most ONE confirmation per order: the dedupKey is order + event + channel + template
 * (unique index). ZBS messages are paid, so every path that could duplicate a send
 * (timeouts, lost leases, manual retries of UNKNOWN) stops for a human instead.
 */
@Injectable()
export class ZbsOrderConfirmationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZbsOrderConfirmationService.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<ZbsRunOnceResult> | null = null;

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(NotificationJob.name) private readonly jobModel: Model<NotificationJobDocument>,
    private readonly configService: ZaloZbsConfigService,
    private readonly client: ZbsApiClient,
    private readonly auth: ZbsAuthService,
    private readonly auditService: AuditService,
    private readonly templates: ZbsTemplateService,
  ) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  onModuleInit(): void {
    const cfg = this.configService.get();
    if (!cfg.enabled) {
      this.logger.log('ZBS: ZALO_ZBS_ENABLED=false — tin xác nhận đơn hàng cho khách đang tắt');
      return;
    }
    const v = this.configService.validate(cfg);
    if (v.errors.length) this.logger.error(`ZBS cấu hình không hợp lệ: ${v.errors.join('; ')}`);
    v.warnings.forEach((w) => this.logger.warn(`ZBS: ${w}`));
    if (cfg.workerIntervalMs > 0) {
      this.timer = setInterval(() => this.kick(), cfg.workerIntervalMs);
      this.timer.unref();
      this.logger.log(`ZBS worker ${this.workerId} chạy mỗi ${cfg.workerIntervalMs}ms`);
    }
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Producer side (via OrderNotificationService, called by checkout) ───

  /** Outbox marker to persist with a new customer order, or null when ZBS is off. Never throws. */
  outboxMarker(): string | null {
    try {
      return this.configService.get().enabled ? ZBS_ORDER_OUTBOX_MARKER : null;
    } catch (err) {
      this.logger.error(`Không xác định được cấu hình ZBS: ${(err as Error).message}`);
      return null;
    }
  }

  /** Fire-and-forget worker nudge. Never throws, never awaits Zalo. */
  kick(): void {
    try {
      if (!this.configService.get().enabled) return;
    } catch {
      return;
    }
    setImmediate(() => {
      this.runOnce().catch((err) => this.logger.error(`ZBS worker lỗi: ${(err as Error).message}`));
    });
  }

  // ─── Worker ──────────────────────────────────────────────────────────────

  runOnce(): Promise<ZbsRunOnceResult> {
    if (!this.inFlight) {
      this.inFlight = this.doRunOnce().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRunOnce(): Promise<ZbsRunOnceResult> {
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
    const marker = ZBS_ORDER_OUTBOX_MARKER;
    await this.orderModel
      .updateMany({ [ORDER_OUTBOX_FIELD]: marker, isDeleted: true }, { $pull: { [ORDER_OUTBOX_FIELD]: marker } })
      .exec();
    const orders = await this.orderModel
      .find({ [ORDER_OUTBOX_FIELD]: marker })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    for (const order of orders) {
      await this.fanOutOrder(order as unknown as OrderDocument);
      await this.orderModel.updateOne({ _id: order._id }, { $pull: { [ORDER_OUTBOX_FIELD]: marker } }).exec();
    }
    return orders.length;
  }

  /** Creates the order's single ZBS job (idempotent via the unique dedupKey). Problems known
   * up front (ZBS off/misconfigured, unusable phone) are recorded as SKIPPED rows. */
  async fanOutOrder(order: Pick<OrderDocument, '_id' | 'shippingInfo'>): Promise<NotificationStatus> {
    const cfg = this.configService.get();
    const validation = this.configService.validate(cfg);
    const orderId = order._id.toString();
    const phone = normalizeVnPhone(order.shippingInfo?.phone);
    const base = {
      dedupKey: zbsDedupKey(orderId),
      channel: ZALO_ZBS_CHANNEL,
      eventType: NotificationEventType.ORDER_CREATED,
      orderId: new Types.ObjectId(orderId),
      orderCode: orderDisplayCode(orderId),
      templateKey: ZBS_TEMPLATE_ORDER_CONFIRMATION,
      trackingId: buildTrackingId(orderId),
      recipientId: phone.ok ? phone.phone : ZBS_NO_RECIPIENT,
      ...(cfg.templateIdOrderConfirmation ? { templateId: cfg.templateIdOrderConfirmation } : {}),
    };

    if (!validation.valid) {
      await this.insertJob({
        ...base,
        status: NotificationStatus.SKIPPED_NOT_CONFIGURED,
        maxAttempts: 0,
        errorClass: 'CONFIGURATION_REQUIRED',
        lastErrorCode: cfg.enabled ? 'CONFIG_INVALID' : 'ZBS_DISABLED',
        lastErrorMessage: (validation.errors.join('; ') || 'ZBS chưa được bật').slice(0, MAX_ERROR_MESSAGE_LENGTH),
        processedAt: new Date(),
      });
      this.logger.warn(`Đơn ${base.orderCode}: bỏ qua ZBS (${cfg.enabled ? 'CONFIG_INVALID' : 'ZBS_DISABLED'})`);
      return NotificationStatus.SKIPPED_NOT_CONFIGURED;
    }
    if (!phone.ok) {
      await this.insertJob({
        ...base,
        status: NotificationStatus.SKIPPED_INVALID_RECIPIENT,
        maxAttempts: 0,
        errorClass: 'NON_RETRYABLE',
        lastErrorCode: `PHONE_${phone.reason}`,
        lastErrorMessage: 'Số điện thoại của đơn thiếu hoặc không đúng định dạng di động Việt Nam',
        processedAt: new Date(),
      });
      this.logger.warn(`Đơn ${base.orderCode}: bỏ qua ZBS — SĐT không hợp lệ (${phone.reason})`);
      return NotificationStatus.SKIPPED_INVALID_RECIPIENT;
    }
    await this.insertJob({
      ...base,
      status: NotificationStatus.PENDING,
      maxAttempts: cfg.maxRetries + 1,
      nextAttemptAt: new Date(),
    });
    return NotificationStatus.PENDING;
  }

  private async insertJob(fields: Partial<NotificationJob> & { dedupKey: string }): Promise<void> {
    try {
      await this.jobModel
        .updateOne({ dedupKey: fields.dedupKey }, { $setOnInsert: { attemptCount: 0, attempts: [], ...fields } }, { upsert: true })
        .exec();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /** PROCESSING past its lease = worker died mid-send → UNKNOWN (paid message may be out). */
  async recoverStaleJobs(): Promise<number> {
    const now = new Date();
    const res = await this.jobModel
      .updateMany(
        { channel: ZALO_ZBS_CHANNEL, status: NotificationStatus.PROCESSING, lockedUntil: { $lt: now } },
        {
          $set: {
            status: NotificationStatus.UNKNOWN,
            errorClass: 'UNKNOWN_OUTCOME',
            lastErrorCode: 'WORKER_LEASE_EXPIRED',
            lastErrorMessage: 'Worker dừng giữa chừng khi đang gửi — không rõ Zalo đã nhận hay chưa',
            processedAt: now,
          },
          $unset: { lockedUntil: 1, lockOwner: 1 },
        },
      )
      .exec();
    if (res.modifiedCount) this.logger.warn(`ZBS: ${res.modifiedCount} job hết lease → UNKNOWN`);
    return res.modifiedCount;
  }

  async claimNextJob(): Promise<NotificationJobDocument | null> {
    const now = new Date();
    // Covers a token refresh + the send + a single post-refresh resend.
    const leaseMs = this.configService.get().requestTimeoutMs * 3 + 30_000;
    return this.jobModel
      .findOneAndUpdate(
        {
          channel: ZALO_ZBS_CHANNEL,
          status: { $in: [NotificationStatus.PENDING, NotificationStatus.RETRY_PENDING] },
          nextAttemptAt: { $lte: now },
        },
        {
          $set: { status: NotificationStatus.PROCESSING, lockOwner: this.workerId, lockedUntil: new Date(now.getTime() + leaseMs) },
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
      const validation = this.configService.validate(cfg);
      if (!validation.valid) {
        return this.finalize(job, NotificationStatus.SKIPPED_NOT_CONFIGURED, {
          errorClass: 'CONFIGURATION_REQUIRED',
          errorCode: cfg.enabled ? 'CONFIG_INVALID' : 'ZBS_DISABLED',
          errorMessage: validation.errors.join('; ') || 'ZBS đã bị tắt',
          outcome: 'CONFIG',
        });
      }
      const order = await this.orderModel.findById(job.orderId).lean().exec();
      if (!order) {
        return this.finalize(job, NotificationStatus.FAILED, {
          errorClass: 'NON_RETRYABLE',
          errorCode: 'ORDER_NOT_FOUND',
          errorMessage: 'Đơn hàng không còn tồn tại (đã xóa?)',
          outcome: 'PERMANENT',
        });
      }
      if (order.status === OrderStatus.CANCELLED) {
        return this.finalize(job, NotificationStatus.SKIPPED_INELIGIBLE, {
          errorClass: 'NON_RETRYABLE',
          errorCode: 'ORDER_CANCELLED',
          errorMessage: 'Đơn đã bị hủy trước khi gửi — không gửi tin "đã tiếp nhận"',
          outcome: 'SKIPPED',
        });
      }
      const phone = normalizeVnPhone(job.recipientId);
      if (!phone.ok) {
        return this.finalize(job, NotificationStatus.SKIPPED_INVALID_RECIPIENT, {
          errorClass: 'NON_RETRYABLE',
          errorCode: `PHONE_${phone.reason}`,
          errorMessage: 'Số điện thoại người nhận không hợp lệ',
          outcome: 'SKIPPED',
        });
      }

      const gate = await this.templateGate(cfg);
      if (!gate.ready && gate.retryable && job.attemptCount < job.maxAttempts) {
        return this.finalize(job, NotificationStatus.RETRY_PENDING, {
          errorClass: 'RETRYABLE',
          errorCode: gate.errorCode ?? 'TEMPLATE_CHECK_FAILED',
          errorMessage: gate.message ?? 'Không kiểm tra được template',
          outcome: 'TRANSIENT',
          nextAttemptAt: new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, job.attemptCount)),
        });
      }
      if (!gate.ready) {
        return this.finalize(job, NotificationStatus.SKIPPED_NOT_CONFIGURED, {
          errorClass: 'CONFIGURATION_REQUIRED',
          errorCode: gate.errorCode ?? 'TEMPLATE_NOT_READY',
          errorMessage: gate.message ?? 'Template chưa sẵn sàng',
          outcome: 'CONFIG',
        });
      }

      if (cfg.dailySendLimit > 0) {
        const sentToday = await this.jobModel
          .countDocuments({ channel: ZALO_ZBS_CHANNEL, acceptedAt: { $gte: vnPeriodStart(new Date(), 'day') } })
          .exec();
        if (sentToday >= cfg.dailySendLimit) {
          return this.finalize(job, NotificationStatus.FAILED, {
            errorClass: 'CONFIGURATION_REQUIRED',
            errorCode: 'LOCAL_DAILY_LIMIT_REACHED',
            errorMessage: `Đã đạt giới hạn ${cfg.dailySendLimit} tin/ngày (ZALO_ZBS_DAILY_SEND_LIMIT) — gửi lại thủ công nếu cần`,
            outcome: 'CONFIG',
          });
        }
      }

      const mapped = mapOrderToTemplateData(order as unknown as ZbsOrderInput, this.configService.paramMapping(cfg).mapping, {
        orderUrlBase: cfg.orderUrlBase,
        specs: gate.specs,
      });
      if (!mapped.ok) {
        return this.finalize(job, NotificationStatus.FAILED, {
          errorClass: 'NON_RETRYABLE',
          errorCode: mapped.errorCode,
          errorMessage: mapped.errorMessage,
          outcome: 'VALIDATION',
        });
      }

      const token = await this.auth.getAccessToken();
      if (!token.ok) return this.applyAuthFailure(job, token, cfg);

      const request = {
        phone: phone.phone,
        templateId: cfg.templateIdOrderConfirmation,
        templateData: mapped.templateData,
        trackingId: job.trackingId || buildTrackingId(job.orderId.toString()),
      };
      sendStarted = true;
      let res = await this.client.sendTemplate(token.accessToken, request);
      if (!res.ok && res.kind === 'TOKEN_INVALID') {
        // -124 / 401: Zalo rejected the token, so nothing was sent — refresh and resend once.
        const renewed = await this.auth.handleRejectedAccessToken(token.accessToken);
        if (!renewed.ok) return this.applyAuthFailure(job, renewed, cfg);
        res = await this.client.sendTemplate(renewed.accessToken, request);
      }
      return this.applySendResult(job, res, cfg, request.templateId);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`ZBS job ${job._id}: lỗi ngoài dự kiến — ${message}`);
      if (sendStarted) {
        // Can't tell whether Zalo sent it: leave PROCESSING → lease expiry → UNKNOWN.
        return NotificationStatus.PROCESSING;
      }
      const canRetry = job.attemptCount < job.maxAttempts;
      return this.finalize(job, canRetry ? NotificationStatus.RETRY_PENDING : NotificationStatus.FAILED, {
        errorClass: 'RETRYABLE',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: message,
        outcome: 'INTERNAL',
        nextAttemptAt: canRetry ? new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, job.attemptCount)) : undefined,
      });
    }
  }

  /** Token problems happen BEFORE a send, so they never risk a duplicate. */
  private applyAuthFailure(
    job: NotificationJobDocument,
    auth: { errorClass: ZbsErrorClass; errorCode: string; description: string },
    cfg: ZaloZbsConfigSnapshot,
  ): Promise<NotificationStatus> {
    const info = { errorClass: auth.errorClass, errorCode: auth.errorCode, errorMessage: auth.description, outcome: 'AUTH' };
    if ((auth.errorClass === 'RETRYABLE' || auth.errorClass === 'UNKNOWN_OUTCOME') && job.attemptCount < job.maxAttempts) {
      return this.finalize(job, NotificationStatus.RETRY_PENDING, {
        ...info,
        errorClass: 'RETRYABLE',
        nextAttemptAt: new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, job.attemptCount)),
      });
    }
    return this.finalize(job, NotificationStatus.FAILED, info);
  }

  private async applySendResult(
    job: NotificationJobDocument,
    res: ZbsCallResult<ZbsSendData>,
    cfg: ZaloZbsConfigSnapshot,
    templateId: string,
  ): Promise<NotificationStatus> {
    if (res.ok) {
      const d = res.data;
      const msgId = d.msg_id ? String(d.msg_id) : undefined;
      const quota = d.quota
        ? { dailyQuota: toInt(d.quota.dailyQuota), remainingQuota: toInt(d.quota.remainingQuota) }
        : undefined;
      this.logger.log(
        `ZBS: Zalo đã nhận tin xác nhận đơn ${job.orderCode} → ${maskZbsPhone(job.recipientId)} (msg_id ${msgId ?? '-'}, còn ${quota?.remainingQuota ?? '?'} quota)`,
      );
      return this.finalize(job, NotificationStatus.ACCEPTED, {
        outcome: 'ACCEPTED',
        providerMessageId: msgId,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        templateId,
        providerSentTime: toDateFromMs(d.sent_time),
        providerSendingMode: d.sending_mode ? String(d.sending_mode) : undefined,
        providerQuota: quota,
      });
    }

    const info = {
      errorClass: res.errorClass,
      errorCode: res.errorCode,
      errorMessage: res.description,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      outcome: res.errorClass,
      templateId,
    };
    switch (res.errorClass) {
      case 'RETRYABLE': {
        if (job.attemptCount >= job.maxAttempts) return this.finalize(job, NotificationStatus.FAILED, info);
        const next =
          res.kind === 'NIGHT_RESTRICTION'
            ? nextVnMorning(new Date())
            : new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, job.attemptCount));
        return this.finalize(job, NotificationStatus.RETRY_PENDING, { ...info, nextAttemptAt: next });
      }
      case 'UNKNOWN_OUTCOME':
        return this.finalize(job, NotificationStatus.UNKNOWN, info);
      case 'NON_RETRYABLE':
        if (res.kind === 'INVALID_RECIPIENT') return this.finalize(job, NotificationStatus.SKIPPED_INVALID_RECIPIENT, info);
        if (res.kind === 'INELIGIBLE_RECIPIENT') return this.finalize(job, NotificationStatus.SKIPPED_INELIGIBLE, info);
        return this.finalize(job, NotificationStatus.FAILED, info);
      case 'CONFIGURATION_REQUIRED':
        if (res.providerError !== undefined && ZBS_TEMPLATE_UNUSABLE_CODES.has(res.providerError)) {
          await this.markTemplateRejected(templateId, res.providerError, res.description);
        }
        return this.finalize(job, NotificationStatus.FAILED, info);
      case 'AUTHENTICATION_REQUIRED':
      default:
        return this.finalize(job, NotificationStatus.FAILED, info);
    }
  }

  private async finalize(
    job: NotificationJobDocument,
    status: NotificationStatus,
    info: {
      outcome: string;
      errorClass?: ZbsErrorClass;
      errorCode?: string;
      errorMessage?: string;
      httpStatus?: number;
      durationMs?: number;
      providerMessageId?: string;
      nextAttemptAt?: Date;
      templateId?: string;
      providerSentTime?: Date;
      providerSendingMode?: string;
      providerQuota?: { dailyQuota?: number; remainingQuota?: number };
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
      $unset.errorClass = 1;
      if (info.providerMessageId) $set.providerMessageId = info.providerMessageId;
      if (info.providerSentTime) $set.providerSentTime = info.providerSentTime;
      if (info.providerSendingMode) $set.providerSendingMode = info.providerSendingMode;
      if (info.providerQuota) $set.providerQuota = info.providerQuota;
    } else {
      if (info.errorClass) $set.errorClass = info.errorClass;
      if (info.errorCode) $set.lastErrorCode = info.errorCode;
      if (info.errorMessage) $set.lastErrorMessage = info.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    }
    if (info.templateId) $set.templateId = info.templateId;
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
      this.logger.warn(`ZBS job ${job._id}: mất lease trước khi lưu kết quả ${status}`);
    } else if (status !== NotificationStatus.ACCEPTED) {
      this.logger.warn(`ZBS: đơn ${job.orderCode} → ${maskZbsPhone(job.recipientId)}: ${status} (${info.errorCode ?? '-'})`);
    }
    return status;
  }

  // ─── Template verification ───────────────────────────────────────────────

  private templateTarget(cfg: ZaloZbsConfigSnapshot = this.configService.get()): ZbsTemplateTarget {
    return {
      templateKey: ZBS_TEMPLATE_ORDER_CONFIRMATION,
      templateId: cfg.templateIdOrderConfirmation,
      mapping: this.configService.paramMapping(cfg).mapping,
      manuallyVerified: !!cfg.templateManuallyVerified && cfg.templateManuallyVerified === cfg.templateIdOrderConfirmation,
      templateIdEnv: 'ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION',
      manualEnv: 'ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED',
    };
  }

  /**
   * Sending is allowed only when the configured template is known to be ENABLE and the ENV
   * mapping matches its approved params — or the operator attested it manually
   * (ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED=<template id>) because the app lacks the
   * template-management permission. Approval is never assumed.
   */
  templateGate(cfg: ZaloZbsConfigSnapshot = this.configService.get()): Promise<ZbsTemplateGate> {
    return this.templates.gate(this.templateTarget(cfg));
  }

  /** GET /template/info/v2 for the configured template; stores the result. Works while
   * ZALO_ZBS_ENABLED=false so the operator can verify before activation. */
  verifyTemplate(): Promise<ZbsTemplateVerifyResult> {
    return this.templates.verify(this.templateTarget());
  }

  private markTemplateRejected(templateId: string, code: number, description: string): Promise<void> {
    return this.templates.markRejected(ZBS_TEMPLATE_ORDER_CONFIRMATION, templateId, code, description);
  }

  templateView() {
    const cfg = this.configService.get();
    const mapping = this.configService.paramMapping(cfg);
    return this.templates.view(
      this.templateTarget(cfg),
      mapping.mapping.map((m) => ({ param: m.param, source: m.source ?? 'const' })),
      mapping.errors,
    );
  }

  // ─── Admin operations ────────────────────────────────────────────────────

  async listJobs(query: {
    status?: NotificationStatus;
    orderCode?: string;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }) {
    const filter: Record<string, unknown> = { channel: ZALO_ZBS_CHANNEL };
    if (query.status) filter.status = query.status;
    if (query.orderCode) {
      const code = query.orderCode.trim().replace(/^#/, '');
      if (Types.ObjectId.isValid(code) && code.length === 24) {
        filter.orderId = new Types.ObjectId(code);
      } else if (/^[A-Za-z0-9]{1,24}$/.test(code)) {
        filter.orderCode = { $regex: `${code.toUpperCase()}$` };
      } else {
        throw new BadRequestException('Mã đơn không hợp lệ');
      }
    }
    if (query.from || query.to) {
      filter.createdAt = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
    }
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const [rows, total] = await Promise.all([
      this.jobModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.jobModel.countDocuments(filter).exec(),
    ]);
    return {
      data: rows.map((j) => ({
        _id: j._id.toString(),
        orderId: j.orderId.toString(),
        orderCode: j.orderCode,
        channel: j.channel,
        eventType: j.eventType,
        templateKey: j.templateKey,
        templateId: j.templateId,
        trackingId: j.trackingId,
        recipient: j.recipientId === ZBS_NO_RECIPIENT ? null : maskZbsPhone(j.recipientId),
        status: j.status,
        errorClass: j.errorClass,
        attemptCount: j.attemptCount,
        maxAttempts: j.maxAttempts,
        nextAttemptAt: j.nextAttemptAt,
        providerMessageId: j.providerMessageId,
        providerQuota: j.providerQuota,
        providerDeliveryStatus: j.providerDeliveryStatus,
        deliveryCheckedAt: j.deliveryCheckedAt,
        lastErrorCode: j.lastErrorCode,
        lastErrorMessage: j.lastErrorMessage,
        lastHttpStatus: j.lastHttpStatus,
        attempts: j.attempts,
        acceptedAt: j.acceptedAt,
        deliveredAt: j.deliveredAt,
        processedAt: j.processedAt,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        retryable: RETRYABLE_STATUSES.includes(j.status),
        deliveryCheckable: !!j.providerMessageId && j.status === NotificationStatus.ACCEPTED,
      })),
      total,
      page,
      limit,
    };
  }

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await this.jobModel
      .aggregate<{ _id: string; count: number }>([
        { $match: { channel: ZALO_ZBS_CHANNEL } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }

  /** Accepted counts + last provider quota + a clearly-labelled cost ESTIMATE. */
  async stats() {
    const cfg = this.configService.get();
    const now = new Date();
    const [acceptedToday, acceptedThisMonth, deliveredThisMonth, lastAccepted, template] = await Promise.all([
      this.jobModel.countDocuments({ channel: ZALO_ZBS_CHANNEL, acceptedAt: { $gte: vnPeriodStart(now, 'day') } }).exec(),
      this.jobModel.countDocuments({ channel: ZALO_ZBS_CHANNEL, acceptedAt: { $gte: vnPeriodStart(now, 'month') } }).exec(),
      this.jobModel
        .countDocuments({ channel: ZALO_ZBS_CHANNEL, status: NotificationStatus.DELIVERED, acceptedAt: { $gte: vnPeriodStart(now, 'month') } })
        .exec(),
      this.jobModel
        .findOne({ channel: ZALO_ZBS_CHANNEL, providerQuota: { $exists: true } })
        .sort({ acceptedAt: -1 })
        .lean()
        .exec(),
      cfg.templateIdOrderConfirmation ? this.templates.record(ZBS_TEMPLATE_ORDER_CONFIRMATION, cfg.templateIdOrderConfirmation) : null,
    ]);
    const unitPrice = cfg.unitPriceVnd > 0 ? cfg.unitPriceVnd : (template?.priceSdt ?? null);
    return {
      acceptedToday,
      acceptedThisMonth,
      deliveredThisMonth,
      dailySendLimit: cfg.dailySendLimit,
      lastQuota: lastAccepted?.providerQuota
        ? { ...lastAccepted.providerQuota, reportedAt: lastAccepted.acceptedAt }
        : null,
      costEstimate:
        unitPrice !== null
          ? {
              unitPriceVnd: unitPrice,
              unitPriceSource: cfg.unitPriceVnd > 0 ? 'ENV' : 'TEMPLATE_INFO',
              acceptedThisMonthVnd: unitPrice * acceptedThisMonth,
              note: 'Ước tính = số tin Zalo đã nhận × đơn giá. Không phải số tiền trên hóa đơn ZBS.',
            }
          : null,
    };
  }

  /**
   * Manual retry (admin): exactly ONE more attempt. Never for ACCEPTED/DELIVERED (already
   * paid). UNKNOWN requires `confirmUnknownOutcome` — the admin checked with the customer /
   * ZBS portal that the message did NOT arrive. The phone is re-read from the order, so a
   * corrected phone number is picked up.
   */
  async retryJob(id: string, staffId: string, confirmUnknownOutcome = false) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Mã thông báo không hợp lệ');
    const job = await this.jobModel.findById(id).exec();
    if (!job || job.channel !== ZALO_ZBS_CHANNEL) throw new NotFoundException('Không tìm thấy thông báo ZBS');
    if (!RETRYABLE_STATUSES.includes(job.status) || job.providerMessageId) {
      throw new BadRequestException(`Không thể gửi lại thông báo ở trạng thái ${job.status}`);
    }
    if (job.status === NotificationStatus.UNKNOWN && !confirmUnknownOutcome) {
      throw new BadRequestException(
        'Kết quả lần gửi trước không xác định — Zalo có thể ĐÃ gửi (và đã tính phí). Hãy xác minh với khách hoặc trên ZBS trước; xác nhận bằng confirmUnknownOutcome=true',
      );
    }
    const v = this.configService.validate();
    if (!v.valid) throw new BadRequestException(`Cấu hình ZBS chưa hợp lệ: ${v.errors.join('; ') || 'ZALO_ZBS_ENABLED=false'}`);
    const gate = await this.templateGate();
    if (!gate.ready) throw new BadRequestException(`Template chưa sẵn sàng: ${gate.message}`);
    const order = await this.orderModel.findById(job.orderId).lean().exec();
    if (!order) throw new BadRequestException('Đơn hàng không còn tồn tại');
    if (order.status === OrderStatus.CANCELLED) throw new BadRequestException('Đơn đã hủy — không gửi xác nhận');
    const phone = normalizeVnPhone(order.shippingInfo?.phone);
    if (!phone.ok) throw new BadRequestException('Số điện thoại của đơn không hợp lệ — sửa SĐT trên đơn trước');

    const res = await this.jobModel
      .updateOne(
        { _id: job._id, status: job.status, providerMessageId: { $exists: false } },
        {
          $set: {
            status: NotificationStatus.RETRY_PENDING,
            recipientId: phone.phone,
            nextAttemptAt: new Date(),
            maxAttempts: job.attemptCount + 1,
          },
          $unset: { processedAt: 1 },
        },
      )
      .exec();
    if (!res.modifiedCount) throw new BadRequestException('Thông báo vừa được cập nhật bởi tiến trình khác, thử lại sau');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'ZALO_ZBS_NOTIFICATION_RETRY',
      module: 'zalo-zbs',
      targetId: id,
      beforeData: { status: job.status, attemptCount: job.attemptCount, lastErrorCode: job.lastErrorCode },
      afterData: { requeued: true, confirmUnknownOutcome },
    });
    this.kick();
    return { mode: 'requeued' as const };
  }

  /** Asks Zalo whether an ACCEPTED message reached the customer's phone (message-status API).
   * Only status 1 ("đã tới máy người dùng") moves the row to DELIVERED. */
  async checkDelivery(id: string, staffId?: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Mã thông báo không hợp lệ');
    const job = await this.jobModel.findById(id).exec();
    if (!job || job.channel !== ZALO_ZBS_CHANNEL) throw new NotFoundException('Không tìm thấy thông báo ZBS');
    if (!job.providerMessageId || ![NotificationStatus.ACCEPTED, NotificationStatus.DELIVERED].includes(job.status)) {
      throw new BadRequestException('Chỉ kiểm tra được tin đã được Zalo nhận (có msg_id)');
    }
    const token = await this.auth.getAccessToken();
    if (!token.ok) throw new BadRequestException(`Không lấy được access token: ${token.errorCode}`);
    let res = await this.client.getMessageStatus(token.accessToken, job.providerMessageId, job.recipientId);
    if (!res.ok && res.kind === 'TOKEN_INVALID') {
      const renewed = await this.auth.handleRejectedAccessToken(token.accessToken);
      if (!renewed.ok) throw new BadRequestException(`Không lấy được access token: ${renewed.errorCode}`);
      res = await this.client.getMessageStatus(renewed.accessToken, job.providerMessageId, job.recipientId);
    }
    if (!res.ok) return { ok: false, errorCode: res.errorCode, description: res.description };

    const providerStatus = toInt(res.data.status);
    const now = new Date();
    const $set: Record<string, unknown> = { deliveryCheckedAt: now };
    if (providerStatus !== undefined) $set.providerDeliveryStatus = providerStatus;
    if (providerStatus === 1) {
      $set.status = NotificationStatus.DELIVERED;
      $set.deliveredAt = toDateFromMs(res.data.delivery_time) ?? now;
    }
    await this.jobModel.updateOne({ _id: job._id, status: { $in: [NotificationStatus.ACCEPTED, NotificationStatus.DELIVERED] } }, { $set }).exec();
    if (staffId) {
      await this.auditService.log({
        actorId: staffId,
        actorType: 'staff',
        action: 'ZALO_ZBS_DELIVERY_CHECK',
        module: 'zalo-zbs',
        targetId: id,
        afterData: { providerStatus },
      });
    }
    return {
      ok: true,
      providerStatus,
      meaning:
        providerStatus === 1
          ? 'Tin đã tới điện thoại người nhận'
          : providerStatus === 0
            ? 'Zalo đã nhận nhưng chưa tới điện thoại người nhận'
            : providerStatus === -1
              ? 'Zalo không tìm thấy tin nhắn'
              : (res.data.message ?? 'Không rõ'),
      deliveredAt: $set.deliveredAt ?? job.deliveredAt ?? null,
    };
  }
}

const RETRYABLE_STATUSES: NotificationStatus[] = [
  NotificationStatus.FAILED,
  NotificationStatus.UNKNOWN,
  NotificationStatus.SKIPPED_NOT_CONFIGURED,
  NotificationStatus.SKIPPED_INVALID_RECIPIENT,
];

/** Zalo timestamps are millisecond strings ("1626926349402"). */
function toDateFromMs(v: unknown): Date | undefined {
  const n = toInt(v);
  if (n !== undefined && n > 1e12) return new Date(n);
  if (typeof v === 'string' && v && isNaN(Number(v))) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
