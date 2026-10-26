import {
  BadRequestException,
  ConflictException,
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
import { CouponItem, Promotion, PromotionDocument } from '../promotions/schemas/promotion.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import {
  ZbsCampaign,
  ZbsCampaignAudience,
  ZbsCampaignDocument,
  ZbsCampaignExclusions,
  ZbsCampaignStatus,
} from './schemas/zbs-campaign.schema';
import {
  ZbsCampaignMessage,
  ZbsCampaignMessageDocument,
  ZbsCampaignMessageStatus as MsgStatus,
} from './schemas/zbs-campaign-message.schema';
import { ZaloZbsConfigService, ZaloZbsConfigSnapshot } from './zalo-zbs.config';
import { ZbsApiClient, ZbsCallResult, ZbsSendData } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { maskZbsPhone, normalizeVnPhone } from './zbs-phone';
import { mapPromotionToTemplateData, ZbsPromotionInput } from './zbs-promotion.mapper';
import { toInt, ZbsTemplateService, ZbsTemplateTarget } from './zbs-template.service';
import { retryDelayMs, vnPeriodStart } from './zbs-order-confirmation.service';
import { ZBS_TEMPLATE_PROMOTION, ZBS_TEMPLATE_UNUSABLE_CODES, ZBS_TRACKING_ID_MAX_LENGTH, ZbsErrorClass } from './zalo-zbs.constants';

const SEND_BATCH = 10;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const VN_OFFSET_MS = 7 * 3600 * 1000;
/** A draft's recipient snapshot goes stale; confirming an older one is refused. */
export const ZBS_CAMPAIGN_DRAFT_TTL_MS = 24 * 3600 * 1000;
/** Zalo's per-OA / per-template daily quotas — wait for the next day instead of failing. */
const DAILY_QUOTA_CODES = new Set<number>([-144, -147]);
const OPEN_STATUSES = [ZbsCampaignStatus.DRAFT, ZbsCampaignStatus.SENDING, ZbsCampaignStatus.PAUSED];
const QUEUED = [MsgStatus.PENDING, MsgStatus.RETRY_PENDING];

export function zbsCampaignDedupKey(couponId: string, phone: string): string {
  return `PROMO:${couponId}:${phone}`;
}

export function buildCampaignTrackingId(messageId: string): string {
  return `LGPR${messageId}`.replace(/[^A-Za-z0-9]/g, '').slice(0, ZBS_TRACKING_ID_MAX_LENGTH);
}

/** Vietnam hour of `now` is inside [start, end). */
export function inVnSendWindow(now: Date, startHour: number, endHour: number): boolean {
  const h = new Date(now.getTime() + VN_OFFSET_MS).getUTCHours();
  return h >= startHour && h < endHour;
}

/** Next moment the send window opens (today if before it, otherwise tomorrow), VN time. */
export function nextVnWindowStart(now: Date, startHour: number): Date {
  const today = vnPeriodStart(now, 'day').getTime() + startHour * 3600 * 1000;
  return new Date(today > now.getTime() ? today : today + 24 * 3600 * 1000);
}

/** Tomorrow's window start (VN) — for Zalo's daily quotas, which reset per calendar day. */
export function tomorrowVnWindowStart(now: Date, startHour: number): Date {
  return new Date(vnPeriodStart(now, 'day').getTime() + (24 + startHour) * 3600 * 1000);
}

type PromotionLean = Promotion & { _id: Types.ObjectId };
type CouponLean = CouponItem & { _id: Types.ObjectId };

const COUPON_UNAVAILABLE_LABELS: Record<string, string> = {
  PROMOTION_NOT_FOUND: 'Chương trình khuyến mãi không còn tồn tại',
  PROMOTION_INACTIVE: 'Chương trình khuyến mãi đang tắt',
  PROMOTION_ENDED: 'Chương trình khuyến mãi đã kết thúc',
  COUPON_NOT_FOUND: 'Mã coupon không còn trong chương trình',
  COUPON_EXHAUSTED: 'Mã coupon đã hết lượt sử dụng',
};

/** Why the coupon can no longer be promoted, or null when it still can. */
export function couponUnavailableReason(
  promo: Pick<Promotion, 'isActive' | 'endDate'> | null,
  coupon: Pick<CouponItem, 'totalUsageLimit' | 'totalUsedCount'> | null,
  now: Date,
): string | null {
  if (!promo) return 'PROMOTION_NOT_FOUND';
  if (!promo.isActive) return 'PROMOTION_INACTIVE';
  if (new Date(promo.endDate).getTime() < now.getTime()) return 'PROMOTION_ENDED';
  if (!coupon) return 'COUPON_NOT_FOUND';
  if (coupon.totalUsageLimit > 0 && coupon.totalUsedCount >= coupon.totalUsageLimit) return 'COUPON_EXHAUSTED';
  return null;
}

function userUsedCoupon(coupon: CouponLean, userId: string): boolean {
  const rec = (coupon.usageRecords ?? []).find((r) => r.userId?.toString() === userId);
  return !!rec && rec.count >= Math.max(1, coupon.perUserUsageLimit || 1);
}

function userMayUse(promo: PromotionLean, userId: string): boolean {
  return promo.assignedToAll || (promo.assignedUsers ?? []).some((u) => u.toString() === userId);
}

export interface CreateCampaignInput {
  promotionId: string;
  couponId: string;
  audience: ZbsCampaignAudience;
  name?: string;
}

/** What the worker did with one message. */
type Outcome = MsgStatus | 'REQUEUED' | 'PAUSED';

/**
 * Admin-triggered promotion campaigns over ZBS (PROMOTION template, e.g. 652780).
 *
 * Paid messages to real customers, so every step is explicit and bounded:
 *  - the admin picks an existing Promotion + coupon; the message text comes only from that
 *    coupon (code, value, min order, dates) and the recipient's name — never free text;
 *  - recipients = the chosen audience ∩ users allowed to use the coupon, deduplicated by
 *    phone, minus anyone who already got this coupon (unique PROMO:<coupon>:<phone>);
 *  - a DRAFT shows the exact count, exclusions and a cost estimate; nothing is sent until a
 *    SUPER_ADMIN confirms that exact count;
 *  - sending happens only inside the VN send window and under the local daily cap; any
 *    config/auth/template/coupon problem PAUSES the campaign instead of burning messages;
 *  - UNKNOWN outcomes (timeouts) are never resent automatically.
 * Independent of the order-confirmation worker: own flag, collections and loop.
 */
@Injectable()
export class ZbsPromotionCampaignService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZbsPromotionCampaignService.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}:promo`;
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<{ recovered: number; processed: number; completed: number }> | null = null;

  constructor(
    @InjectModel(ZbsCampaign.name) private readonly campaignModel: Model<ZbsCampaignDocument>,
    @InjectModel(ZbsCampaignMessage.name) private readonly messageModel: Model<ZbsCampaignMessageDocument>,
    @InjectModel(Promotion.name) private readonly promotionModel: Model<PromotionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly configService: ZaloZbsConfigService,
    private readonly client: ZbsApiClient,
    private readonly auth: ZbsAuthService,
    private readonly templates: ZbsTemplateService,
    private readonly auditService: AuditService,
  ) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  onModuleInit(): void {
    const cfg = this.configService.get();
    if (!cfg.promotionEnabled) {
      this.logger.log('ZBS: ZALO_ZBS_PROMOTION_ENABLED=false — chiến dịch khuyến mãi đang tắt');
      return;
    }
    const v = this.configService.validatePromotion(cfg);
    if (v.errors.length) this.logger.error(`ZBS khuyến mãi cấu hình không hợp lệ: ${v.errors.join('; ')}`);
    if (cfg.workerIntervalMs > 0) {
      this.timer = setInterval(() => this.kick(), cfg.workerIntervalMs);
      this.timer.unref();
    }
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  kick(): void {
    try {
      if (!this.configService.get().promotionEnabled) return;
    } catch {
      return;
    }
    setImmediate(() => {
      this.runOnce().catch((err) => this.logger.error(`ZBS worker khuyến mãi lỗi: ${(err as Error).message}`));
    });
  }

  private templateTarget(cfg: ZaloZbsConfigSnapshot = this.configService.get()): ZbsTemplateTarget {
    return {
      templateKey: ZBS_TEMPLATE_PROMOTION,
      templateId: cfg.templateIdPromotion,
      mapping: this.configService.promotionParamMapping(cfg).mapping,
      manuallyVerified: !!cfg.promotionTemplateManuallyVerified && cfg.promotionTemplateManuallyVerified === cfg.templateIdPromotion,
      templateIdEnv: 'ZALO_ZBS_TEMPLATE_PROMOTION',
      manualEnv: 'ZALO_ZBS_PROMOTION_TEMPLATE_MANUALLY_VERIFIED',
    };
  }

  templateGate(cfg: ZaloZbsConfigSnapshot = this.configService.get()) {
    return this.templates.gate(this.templateTarget(cfg));
  }

  verifyTemplate() {
    return this.templates.verify(this.templateTarget());
  }

  // ─── Draft ───────────────────────────────────────────────────────────────

  async createDraft(input: CreateCampaignInput, staffId: string) {
    const cfg = this.configService.get();
    const v = this.configService.validatePromotion(cfg);
    if (v.errors.length) throw new BadRequestException(`Cấu hình ZBS khuyến mãi chưa hợp lệ: ${v.errors.join('; ')}`);
    if (!Types.ObjectId.isValid(input.promotionId) || !Types.ObjectId.isValid(input.couponId)) {
      throw new BadRequestException('Mã chương trình/coupon không hợp lệ');
    }
    if (!Object.values(ZbsCampaignAudience).includes(input.audience)) throw new BadRequestException('Tệp người nhận không hợp lệ');

    const now = new Date();
    const promo = (await this.promotionModel.findById(input.promotionId).lean().exec()) as PromotionLean | null;
    const coupon = (promo?.coupons ?? []).find((c) => c._id.toString() === input.couponId) as CouponLean | undefined;
    const unavailable = couponUnavailableReason(promo, coupon ?? null, now);
    if (unavailable) throw new BadRequestException(COUPON_UNAVAILABLE_LABELS[unavailable]);

    const open = await this.campaignModel.findOne({ couponId: new Types.ObjectId(input.couponId), status: { $in: OPEN_STATUSES } }).lean().exec();
    if (open) {
      throw new ConflictException(`Coupon ${coupon!.code} đang có chiến dịch "${open.name}" (${open.status}) — kết thúc hoặc hủy nó trước`);
    }

    const gate = await this.templateGate(cfg);
    if (!gate.ready) throw new BadRequestException(`Template khuyến mãi chưa sẵn sàng: ${gate.message}`);

    const { recipients, exclusions } = await this.resolveRecipients(promo!, coupon!, input.audience, input.couponId);
    if (!recipients.length) {
      throw new BadRequestException({ message: 'Không có người nhận hợp lệ cho chiến dịch này', exclusions });
    }
    if (recipients.length > cfg.promotionMaxRecipients) {
      throw new BadRequestException(
        `${recipients.length} người nhận vượt giới hạn ${cfg.promotionMaxRecipients}/chiến dịch (ZALO_ZBS_PROMOTION_MAX_RECIPIENTS)`,
      );
    }

    // Coupon fields are identical for everyone and the name is truncatable, so mapping the
    // first recipient proves the whole campaign fits the approved template.
    const sample = mapPromotionToTemplateData(
      { customerName: recipients[0].name, promotion: promo!, coupon: coupon! },
      this.configService.promotionParamMapping(cfg).mapping,
      gate.specs,
    );
    if (!sample.ok) throw new BadRequestException(`Không dựng được nội dung tin: ${sample.errorMessage}`);

    const record = await this.templates.record(ZBS_TEMPLATE_PROMOTION, cfg.templateIdPromotion);
    const unitPriceVnd = record?.priceSdt ?? (cfg.unitPriceVnd > 0 ? cfg.unitPriceVnd : undefined);
    const campaign = await this.campaignModel.create({
      name: input.name?.trim() || `${promo!.name} · ${coupon!.code}`,
      promotionId: promo!._id,
      couponId: coupon!._id,
      couponCode: coupon!.code,
      promotionName: promo!.name,
      audience: input.audience,
      templateId: cfg.templateIdPromotion,
      status: ZbsCampaignStatus.DRAFT,
      recipientCount: 0,
      exclusions,
      unitPriceVnd,
      createdBy: new Types.ObjectId(staffId),
    });

    const docs = recipients.map((r) => {
      const _id = new Types.ObjectId();
      return {
        _id,
        campaignId: campaign._id,
        dedupKey: zbsCampaignDedupKey(input.couponId, r.phone),
        userId: new Types.ObjectId(r.userId),
        phone: r.phone,
        trackingId: buildCampaignTrackingId(_id.toString()),
        status: MsgStatus.DRAFT,
        maxAttempts: cfg.maxRetries + 1,
        attempts: [],
      };
    });
    let inserted = docs.length;
    try {
      await this.messageModel.insertMany(docs, { ordered: false });
    } catch (err) {
      // A concurrent campaign took some phones in the meantime (unique dedupKey).
      const e = err as { code?: number; insertedDocs?: unknown[]; result?: { insertedCount?: number } };
      if (e.code !== 11000) {
        await this.messageModel.deleteMany({ campaignId: campaign._id }).exec();
        await this.campaignModel.deleteOne({ _id: campaign._id }).exec();
        throw err;
      }
      inserted = await this.messageModel.countDocuments({ campaignId: campaign._id }).exec();
      exclusions.alreadyReceived += docs.length - inserted;
    }

    const warnings: string[] = [];
    const remaining = coupon!.totalUsageLimit > 0 ? coupon!.totalUsageLimit - coupon!.totalUsedCount : null;
    if (remaining !== null && remaining < inserted) {
      warnings.push(`Coupon chỉ còn ${remaining} lượt dùng cho ${inserted} người nhận — người dùng sau sẽ báo "hết lượt"`);
    }
    if (new Date(promo!.startDate).getTime() > now.getTime()) {
      warnings.push('Chương trình chưa bắt đầu — khách chỉ dùng được coupon từ ngày bắt đầu');
    }
    if (new Date(promo!.endDate).getTime() - now.getTime() < 24 * 3600 * 1000) {
      warnings.push('Chương trình kết thúc trong vòng 24 giờ');
    }
    if (cfg.promotionDailySendLimit > 0 && inserted > cfg.promotionDailySendLimit) {
      warnings.push(`Vượt giới hạn ${cfg.promotionDailySendLimit} tin/ngày — chiến dịch sẽ gửi trong nhiều ngày`);
    }
    await this.campaignModel.updateOne({ _id: campaign._id }, { $set: { recipientCount: inserted, exclusions, warnings } }).exec();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'ZALO_ZBS_CAMPAIGN_CREATE',
      module: 'zalo-zbs',
      targetId: campaign._id.toString(),
      afterData: { promotionId: input.promotionId, couponCode: coupon!.code, audience: input.audience, recipientCount: inserted },
    });
    return {
      campaign: await this.getCampaign(campaign._id.toString()),
      preview: { templateData: sample.templateData, samplePhone: maskZbsPhone(recipients[0].phone) },
    };
  }

  /**
   * Audience ∩ allowed-to-use-the-coupon, one row per phone. The phone is the latest
   * storefront order's (the number the customer actually uses with us) or the account's.
   * Marketplace orders (externalRef) are ignored: their buyers are not storefront customers.
   */
  private async resolveRecipients(promo: PromotionLean, coupon: CouponLean, audience: ZbsCampaignAudience, couponId: string) {
    const exclusions: ZbsCampaignExclusions = {
      noPhone: 0,
      invalidPhone: 0,
      duplicatePhone: 0,
      blockedOrDeleted: 0,
      notAllowedByPromotion: 0,
      couponAlreadyUsed: 0,
      alreadyReceived: 0,
    };
    let userIds: Types.ObjectId[];
    if (audience === ZbsCampaignAudience.ASSIGNED_USERS) {
      userIds = (promo.assignedUsers ?? []).map((u) => new Types.ObjectId(u.toString()));
    } else {
      const statusFilter = audience === ZbsCampaignAudience.DELIVERED_CUSTOMERS ? OrderStatus.DELIVERED : { $ne: OrderStatus.CANCELLED };
      userIds = await this.orderModel
        .distinct('userId', { isDeleted: false, externalRef: { $exists: false }, status: statusFilter })
        .exec();
    }
    userIds.sort((a, b) => a.toString().localeCompare(b.toString()));

    const latestPhones = await this.orderModel
      .aggregate<{ _id: Types.ObjectId; phone?: string }>([
        { $match: { userId: { $in: userIds }, isDeleted: false, externalRef: { $exists: false } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', phone: { $first: '$shippingInfo.phone' } } },
      ])
      .exec();
    const orderPhone = new Map(latestPhones.map((r) => [r._id.toString(), r.phone]));
    const users = await this.userModel.find({ _id: { $in: userIds } }).select('name phone isDeleted isBlocked').lean().exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    const existing = new Set(
      (await this.messageModel.find({ dedupKey: { $regex: `^PROMO:${couponId}:` } }).select('dedupKey').lean().exec()).map((m) => m.dedupKey),
    );

    const seenPhones = new Set<string>();
    const recipients: Array<{ userId: string; phone: string; name?: string }> = [];
    for (const oid of userIds) {
      const id = oid.toString();
      const user = userById.get(id);
      if (!user || user.isDeleted || user.isBlocked) {
        exclusions.blockedOrDeleted++;
        continue;
      }
      if (!userMayUse(promo, id)) {
        exclusions.notAllowedByPromotion++;
        continue;
      }
      if (userUsedCoupon(coupon, id)) {
        exclusions.couponAlreadyUsed++;
        continue;
      }
      const raw = orderPhone.get(id) || user.phone;
      if (!raw) {
        exclusions.noPhone++;
        continue;
      }
      const phone = normalizeVnPhone(raw);
      if (!phone.ok) {
        exclusions.invalidPhone++;
        continue;
      }
      if (seenPhones.has(phone.phone)) {
        exclusions.duplicatePhone++;
        continue;
      }
      seenPhones.add(phone.phone);
      if (existing.has(zbsCampaignDedupKey(couponId, phone.phone))) {
        exclusions.alreadyReceived++;
        continue;
      }
      recipients.push({ userId: id, phone: phone.phone, name: user.name });
    }
    return { recipients, exclusions };
  }

  // ─── Admin transitions ───────────────────────────────────────────────────

  /** DRAFT → SENDING. The admin must restate the exact recipient count (= paid messages). */
  async confirm(id: string, expectedRecipients: number, staffId: string) {
    const campaign = await this.findCampaign(id);
    if (campaign.status !== ZbsCampaignStatus.DRAFT) throw new BadRequestException(`Chiến dịch đang ở trạng thái ${campaign.status}`);
    if (Date.now() - new Date(campaign.createdAt).getTime() > ZBS_CAMPAIGN_DRAFT_TTL_MS) {
      throw new BadRequestException('Bản nháp đã quá 24 giờ — danh sách người nhận có thể đã cũ. Hãy hủy và tạo lại');
    }
    if (expectedRecipients !== campaign.recipientCount) {
      throw new BadRequestException(`Số người nhận xác nhận (${expectedRecipients}) không khớp bản nháp (${campaign.recipientCount})`);
    }
    await this.assertSendable(campaign);

    const res = await this.campaignModel
      .updateOne(
        { _id: campaign._id, status: ZbsCampaignStatus.DRAFT },
        { $set: { status: ZbsCampaignStatus.SENDING, confirmedBy: new Types.ObjectId(staffId), confirmedAt: new Date() } },
      )
      .exec();
    if (!res.modifiedCount) throw new ConflictException('Chiến dịch vừa được cập nhật bởi người khác');
    await this.messageModel
      .updateMany({ campaignId: campaign._id, status: MsgStatus.DRAFT }, { $set: { status: MsgStatus.PENDING, nextAttemptAt: new Date() } })
      .exec();
    await this.audit(staffId, 'ZALO_ZBS_CAMPAIGN_CONFIRM', campaign, { recipientCount: campaign.recipientCount });
    this.kick();
    return this.getCampaign(id);
  }

  async pause(id: string, staffId: string) {
    const campaign = await this.findCampaign(id);
    const res = await this.campaignModel
      .updateOne(
        { _id: campaign._id, status: ZbsCampaignStatus.SENDING },
        { $set: { status: ZbsCampaignStatus.PAUSED, pauseCode: 'MANUAL', pauseReason: 'Tạm dừng bởi quản trị viên' } },
      )
      .exec();
    if (!res.modifiedCount) throw new BadRequestException(`Chỉ tạm dừng được chiến dịch đang gửi (hiện tại: ${campaign.status})`);
    await this.audit(staffId, 'ZALO_ZBS_CAMPAIGN_PAUSE', campaign);
    return this.getCampaign(id);
  }

  /** PAUSED → SENDING, only once whatever paused it is fixed. */
  async resume(id: string, staffId: string) {
    const campaign = await this.findCampaign(id);
    if (campaign.status !== ZbsCampaignStatus.PAUSED) throw new BadRequestException(`Chiến dịch đang ở trạng thái ${campaign.status}`);
    await this.assertSendable(campaign);
    const res = await this.campaignModel
      .updateOne(
        { _id: campaign._id, status: ZbsCampaignStatus.PAUSED },
        { $set: { status: ZbsCampaignStatus.SENDING }, $unset: { pauseCode: 1, pauseReason: 1 } },
      )
      .exec();
    if (!res.modifiedCount) throw new ConflictException('Chiến dịch vừa được cập nhật bởi người khác');
    await this.audit(staffId, 'ZALO_ZBS_CAMPAIGN_RESUME', campaign, { pauseCode: campaign.pauseCode });
    this.kick();
    return this.getCampaign(id);
  }

  /** Unsent messages are dropped (and release their dedup key); sent ones stay as history. */
  async cancel(id: string, staffId: string) {
    const campaign = await this.findCampaign(id);
    if (!OPEN_STATUSES.includes(campaign.status)) throw new BadRequestException(`Chiến dịch đã ${campaign.status}`);
    const res = await this.campaignModel
      .updateOne(
        { _id: campaign._id, status: campaign.status },
        { $set: { status: ZbsCampaignStatus.CANCELLED, cancelledBy: new Types.ObjectId(staffId), cancelledAt: new Date() } },
      )
      .exec();
    if (!res.modifiedCount) throw new ConflictException('Chiến dịch vừa được cập nhật bởi người khác');
    if (campaign.status === ZbsCampaignStatus.DRAFT) {
      await this.messageModel.deleteMany({ campaignId: campaign._id, status: MsgStatus.DRAFT }).exec();
    } else {
      await this.cancelQueued({ campaignId: campaign._id });
    }
    await this.audit(staffId, 'ZALO_ZBS_CAMPAIGN_CANCEL', campaign, { from: campaign.status });
    return this.getCampaign(id);
  }

  /** Queued (never sent) messages → CANCELLED, releasing their dedup key. */
  private async cancelQueued(filter: Record<string, unknown>): Promise<void> {
    await this.messageModel
      .updateMany({ ...filter, status: { $in: QUEUED } }, [
        {
          $set: {
            status: MsgStatus.CANCELLED,
            dedupKey: { $concat: ['$dedupKey', ':cancelled:', { $toString: '$_id' }] },
            processedAt: '$$NOW',
          },
        },
      ])
      .exec();
  }

  private async assertSendable(campaign: ZbsCampaignDocument): Promise<void> {
    const cfg = this.configService.get();
    const v = this.configService.validatePromotion(cfg);
    if (!v.valid) throw new BadRequestException(`Cấu hình ZBS khuyến mãi chưa hợp lệ: ${v.errors.join('; ') || 'ZALO_ZBS_PROMOTION_ENABLED=false'}`);
    if (campaign.templateId !== cfg.templateIdPromotion) {
      throw new BadRequestException(`Template đã đổi (${campaign.templateId} → ${cfg.templateIdPromotion}) — hãy hủy và tạo chiến dịch mới`);
    }
    const { promo, coupon } = await this.loadCoupon(campaign);
    const unavailable = couponUnavailableReason(promo, coupon, new Date());
    if (unavailable) throw new BadRequestException(COUPON_UNAVAILABLE_LABELS[unavailable]);
    const gate = await this.templateGate(cfg);
    if (!gate.ready) throw new BadRequestException(`Template khuyến mãi chưa sẵn sàng: ${gate.message}`);
  }

  private async loadCoupon(campaign: Pick<ZbsCampaign, 'promotionId' | 'couponId'>) {
    const promo = (await this.promotionModel.findById(campaign.promotionId).lean().exec()) as PromotionLean | null;
    const coupon = ((promo?.coupons ?? []).find((c) => c._id.toString() === campaign.couponId.toString()) ?? null) as CouponLean | null;
    return { promo, coupon };
  }

  private async findCampaign(id: string): Promise<ZbsCampaignDocument> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Mã chiến dịch không hợp lệ');
    const campaign = await this.campaignModel.findById(id).exec();
    if (!campaign) throw new NotFoundException('Không tìm thấy chiến dịch');
    return campaign;
  }

  private audit(staffId: string, action: string, campaign: ZbsCampaignDocument, afterData: Record<string, unknown> = {}) {
    return this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action,
      module: 'zalo-zbs',
      targetId: campaign._id.toString(),
      beforeData: { status: campaign.status },
      afterData,
    });
  }

  // ─── Worker ──────────────────────────────────────────────────────────────

  runOnce() {
    if (!this.inFlight) {
      this.inFlight = this.doRunOnce().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRunOnce() {
    const recovered = await this.recoverStaleMessages();
    let processed = 0;
    const cfg = this.configService.get();
    const now = new Date();
    if (this.configService.validatePromotion(cfg).valid && inVnSendWindow(now, cfg.promotionSendStartHour, cfg.promotionSendEndHour)) {
      let budget = SEND_BATCH;
      if (cfg.promotionDailySendLimit > 0) {
        const today = await this.messageModel.countDocuments({ acceptedAt: { $gte: vnPeriodStart(now, 'day') } }).exec();
        budget = Math.min(budget, Math.max(0, cfg.promotionDailySendLimit - today));
      }
      for (let i = 0; i < budget; i++) {
        // Re-read every time: a send may have paused a campaign.
        const sending = await this.campaignModel.find({ status: ZbsCampaignStatus.SENDING }).select('_id').lean().exec();
        if (!sending.length) break;
        const msg = await this.claimNext(sending.map((c) => c._id));
        if (!msg) break;
        await this.processMessage(msg);
        processed++;
      }
    }
    const completed = await this.completeFinishedCampaigns();
    return { recovered, processed, completed };
  }

  /** PROCESSING past its lease = worker died mid-send → UNKNOWN (the paid message may be out). */
  async recoverStaleMessages(): Promise<number> {
    const now = new Date();
    const res = await this.messageModel
      .updateMany(
        { status: MsgStatus.PROCESSING, lockedUntil: { $lt: now } },
        {
          $set: {
            status: MsgStatus.UNKNOWN,
            errorClass: 'UNKNOWN_OUTCOME',
            lastErrorCode: 'WORKER_LEASE_EXPIRED',
            lastErrorMessage: 'Worker dừng giữa chừng khi đang gửi — không rõ Zalo đã nhận hay chưa',
            processedAt: now,
          },
          $unset: { lockedUntil: 1, lockOwner: 1 },
        },
      )
      .exec();
    if (res.modifiedCount) this.logger.warn(`ZBS khuyến mãi: ${res.modifiedCount} tin hết lease → UNKNOWN`);
    return res.modifiedCount;
  }

  private claimNext(campaignIds: Types.ObjectId[]): Promise<ZbsCampaignMessageDocument | null> {
    const now = new Date();
    const leaseMs = this.configService.get().requestTimeoutMs * 3 + 30_000;
    return this.messageModel
      .findOneAndUpdate(
        { campaignId: { $in: campaignIds }, status: { $in: QUEUED }, nextAttemptAt: { $lte: now } },
        {
          $set: { status: MsgStatus.PROCESSING, lockOwner: this.workerId, lockedUntil: new Date(now.getTime() + leaseMs) },
          $inc: { attemptCount: 1 },
        },
        { sort: { nextAttemptAt: 1, _id: 1 }, new: true },
      )
      .exec();
  }

  async processMessage(msg: ZbsCampaignMessageDocument): Promise<Outcome> {
    const cfg = this.configService.get();
    let sendStarted = false;
    try {
      const campaign = await this.campaignModel.findById(msg.campaignId).lean().exec();
      if (!campaign || campaign.status !== ZbsCampaignStatus.SENDING) {
        return this.requeue(msg, { outcome: 'CAMPAIGN_NOT_SENDING' });
      }
      const { promo, coupon } = await this.loadCoupon(campaign);
      const unavailable = couponUnavailableReason(promo, coupon, new Date());
      if (unavailable) return this.pauseFor(msg, unavailable, COUPON_UNAVAILABLE_LABELS[unavailable]);

      const user = await this.userModel.findById(msg.userId).select('name isDeleted isBlocked').lean().exec();
      if (!user || user.isDeleted || user.isBlocked) {
        return this.finalize(msg, MsgStatus.SKIPPED_INELIGIBLE, {
          outcome: 'SKIPPED',
          errorClass: 'NON_RETRYABLE',
          errorCode: 'USER_BLOCKED_OR_DELETED',
          errorMessage: 'Tài khoản khách đã bị khóa/xóa',
        });
      }
      if (userUsedCoupon(coupon!, msg.userId.toString())) {
        return this.finalize(msg, MsgStatus.SKIPPED_INELIGIBLE, {
          outcome: 'SKIPPED',
          errorClass: 'NON_RETRYABLE',
          errorCode: 'COUPON_ALREADY_USED',
          errorMessage: 'Khách đã dùng coupon này',
        });
      }

      const gate = await this.templateGate(cfg);
      if (!gate.ready && gate.retryable) {
        return this.requeue(msg, { outcome: 'TRANSIENT', errorCode: gate.errorCode }, new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, 1)));
      }
      if (!gate.ready) return this.pauseFor(msg, gate.errorCode ?? 'TEMPLATE_NOT_READY', gate.message ?? 'Template chưa sẵn sàng');

      const input: ZbsPromotionInput = { customerName: user.name, promotion: promo!, coupon: coupon! };
      const mapped = mapPromotionToTemplateData(input, this.configService.promotionParamMapping(cfg).mapping, gate.specs);
      // Coupon-derived values are shared by every recipient — a mapping error stops the campaign.
      if (!mapped.ok) return this.pauseFor(msg, mapped.errorCode, mapped.errorMessage);

      const token = await this.auth.getAccessToken();
      if (!token.ok) return this.applyAuthFailure(msg, token, cfg);

      const request = { phone: msg.phone, templateId: cfg.templateIdPromotion, templateData: mapped.templateData, trackingId: msg.trackingId };
      sendStarted = true;
      let res = await this.client.sendTemplate(token.accessToken, request);
      if (!res.ok && res.kind === 'TOKEN_INVALID') {
        // -124 / 401: Zalo rejected the token, so nothing was sent — refresh and resend once.
        const renewed = await this.auth.handleRejectedAccessToken(token.accessToken);
        if (!renewed.ok) return this.applyAuthFailure(msg, renewed, cfg);
        res = await this.client.sendTemplate(renewed.accessToken, request);
      }
      return this.applySendResult(msg, res, cfg);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`ZBS tin khuyến mãi ${msg._id}: lỗi ngoài dự kiến — ${message}`);
      if (sendStarted) return MsgStatus.PROCESSING; // lease expiry → UNKNOWN
      const canRetry = msg.attemptCount < msg.maxAttempts;
      return this.finalize(msg, canRetry ? MsgStatus.RETRY_PENDING : MsgStatus.FAILED, {
        outcome: 'INTERNAL',
        errorClass: 'RETRYABLE',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: message,
        nextAttemptAt: canRetry ? new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, msg.attemptCount)) : undefined,
      });
    }
  }

  private applyAuthFailure(
    msg: ZbsCampaignMessageDocument,
    auth: { errorClass: ZbsErrorClass; errorCode: string; description: string },
    cfg: ZaloZbsConfigSnapshot,
  ): Promise<Outcome> {
    if ((auth.errorClass === 'RETRYABLE' || auth.errorClass === 'UNKNOWN_OUTCOME') && msg.attemptCount < msg.maxAttempts) {
      return this.finalize(msg, MsgStatus.RETRY_PENDING, {
        outcome: 'AUTH',
        errorClass: 'RETRYABLE',
        errorCode: auth.errorCode,
        errorMessage: auth.description,
        nextAttemptAt: new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, msg.attemptCount)),
      });
    }
    // Token problems happen before a send: nothing went out, so the message waits for the fix.
    return this.pauseFor(msg, auth.errorCode, `Token OA: ${auth.description}`);
  }

  private async applySendResult(msg: ZbsCampaignMessageDocument, res: ZbsCallResult<ZbsSendData>, cfg: ZaloZbsConfigSnapshot): Promise<Outcome> {
    if (res.ok) {
      const d = res.data;
      const quota = d.quota ? { dailyQuota: toInt(d.quota.dailyQuota), remainingQuota: toInt(d.quota.remainingQuota) } : undefined;
      this.logger.log(`ZBS: Zalo đã nhận tin khuyến mãi → ${maskZbsPhone(msg.phone)} (msg_id ${d.msg_id ?? '-'})`);
      return this.finalize(msg, MsgStatus.ACCEPTED, {
        outcome: 'ACCEPTED',
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        providerMessageId: d.msg_id ? String(d.msg_id) : undefined,
        providerSentTime: toDateFromMs(d.sent_time),
        providerQuota: quota,
      });
    }

    const info = {
      outcome: res.errorClass,
      errorClass: res.errorClass,
      errorCode: res.errorCode,
      errorMessage: res.description,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
    };
    switch (res.errorClass) {
      case 'RETRYABLE':
        if (res.kind === 'NIGHT_RESTRICTION') {
          return this.requeue(msg, info, nextVnWindowStart(new Date(), cfg.promotionSendStartHour));
        }
        if (msg.attemptCount >= msg.maxAttempts) return this.finalize(msg, MsgStatus.FAILED, info);
        return this.finalize(msg, MsgStatus.RETRY_PENDING, {
          ...info,
          nextAttemptAt: new Date(Date.now() + retryDelayMs(cfg.retryBaseDelayMs, msg.attemptCount)),
        });
      case 'UNKNOWN_OUTCOME':
        return this.finalize(msg, MsgStatus.UNKNOWN, info);
      case 'NON_RETRYABLE':
        if (res.kind === 'INVALID_RECIPIENT') return this.finalize(msg, MsgStatus.SKIPPED_INVALID_RECIPIENT, info);
        if (res.kind === 'INELIGIBLE_RECIPIENT') return this.finalize(msg, MsgStatus.SKIPPED_INELIGIBLE, info);
        return this.finalize(msg, MsgStatus.FAILED, info);
      case 'CONFIGURATION_REQUIRED':
        if (res.providerError !== undefined && DAILY_QUOTA_CODES.has(res.providerError)) {
          // Zalo's daily quota: nothing was sent; everything queued waits for tomorrow's window.
          const tomorrow = tomorrowVnWindowStart(new Date(), cfg.promotionSendStartHour);
          await this.messageModel.updateMany({ status: { $in: QUEUED } }, { $max: { nextAttemptAt: tomorrow } }).exec();
          return this.requeue(msg, info, tomorrow);
        }
        if (res.providerError !== undefined && ZBS_TEMPLATE_UNUSABLE_CODES.has(res.providerError)) {
          await this.templates.markRejected(ZBS_TEMPLATE_PROMOTION, cfg.templateIdPromotion, res.providerError, res.description);
        }
        // Zalo refused before sending (billing, permission, template): fix it, then resume.
        return this.pauseFor(msg, res.errorCode, res.description, info);
      case 'AUTHENTICATION_REQUIRED':
      default:
        return this.pauseFor(msg, res.errorCode, res.description, info);
    }
  }

  /** Puts a claimed message back in the queue without consuming an attempt (nothing was sent). */
  private async requeue(
    msg: ZbsCampaignMessageDocument,
    info: { outcome: string; errorCode?: string; httpStatus?: number; durationMs?: number },
    nextAttemptAt: Date = new Date(),
  ): Promise<Outcome> {
    await this.messageModel
      .updateOne(
        { _id: msg._id, status: MsgStatus.PROCESSING, lockOwner: this.workerId },
        {
          $set: { status: MsgStatus.PENDING, nextAttemptAt },
          $unset: { lockedUntil: 1, lockOwner: 1 },
          $inc: { attemptCount: -1 },
          $push: { attempts: { $each: [attemptEntry(info)], $slice: -10 } },
        },
      )
      .exec();
    // The campaign may have been cancelled while this message was PROCESSING (cancel only
    // touches queued rows) — don't leave it queued, holding its dedup key.
    const campaign = await this.campaignModel.findById(msg.campaignId).select('status').lean().exec();
    if (!campaign || campaign.status === ZbsCampaignStatus.CANCELLED) {
      await this.cancelQueued({ _id: msg._id });
      return MsgStatus.CANCELLED;
    }
    return 'REQUEUED';
  }

  /** Stops the whole campaign for an operator (the message itself goes back to the queue). */
  private async pauseFor(
    msg: ZbsCampaignMessageDocument,
    code: string,
    reason: string,
    info: { outcome?: string; httpStatus?: number; durationMs?: number } = {},
  ): Promise<Outcome> {
    await this.campaignModel
      .updateOne(
        { _id: msg.campaignId, status: ZbsCampaignStatus.SENDING },
        { $set: { status: ZbsCampaignStatus.PAUSED, pauseCode: code, pauseReason: reason.slice(0, MAX_ERROR_MESSAGE_LENGTH) } },
      )
      .exec();
    await this.requeue(msg, { outcome: info.outcome ?? 'PAUSED', errorCode: code, httpStatus: info.httpStatus, durationMs: info.durationMs });
    this.logger.error(`ZBS: chiến dịch ${msg.campaignId} tạm dừng (${code}) — ${reason}`);
    return 'PAUSED';
  }

  private async finalize(
    msg: ZbsCampaignMessageDocument,
    status: MsgStatus,
    info: {
      outcome: string;
      errorClass?: ZbsErrorClass;
      errorCode?: string;
      errorMessage?: string;
      httpStatus?: number;
      durationMs?: number;
      providerMessageId?: string;
      providerSentTime?: Date;
      providerQuota?: { dailyQuota?: number; remainingQuota?: number };
      nextAttemptAt?: Date;
    },
  ): Promise<Outcome> {
    const now = new Date();
    const $set: Record<string, unknown> = { status };
    const $unset: Record<string, 1> = { lockedUntil: 1, lockOwner: 1 };
    if (status === MsgStatus.ACCEPTED) {
      $set.acceptedAt = now;
      $unset.lastErrorCode = 1;
      $unset.lastErrorMessage = 1;
      $unset.errorClass = 1;
      if (info.providerMessageId) $set.providerMessageId = info.providerMessageId;
      if (info.providerSentTime) $set.providerSentTime = info.providerSentTime;
      if (info.providerQuota) $set.providerQuota = info.providerQuota;
    } else {
      if (info.errorClass) $set.errorClass = info.errorClass;
      if (info.errorCode) $set.lastErrorCode = info.errorCode;
      if (info.errorMessage) $set.lastErrorMessage = info.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    }
    if (info.httpStatus !== undefined) $set.lastHttpStatus = info.httpStatus;
    if (info.nextAttemptAt) $set.nextAttemptAt = info.nextAttemptAt;
    if (status !== MsgStatus.RETRY_PENDING) $set.processedAt = now;

    const res = await this.messageModel
      .updateOne(
        { _id: msg._id, status: MsgStatus.PROCESSING, lockOwner: this.workerId },
        { $set, $unset, $push: { attempts: { $each: [attemptEntry(info)], $slice: -10 } } },
      )
      .exec();
    if (!res.modifiedCount) this.logger.warn(`ZBS tin khuyến mãi ${msg._id}: mất lease trước khi lưu kết quả ${status}`);
    else if (status !== MsgStatus.ACCEPTED) {
      this.logger.warn(`ZBS khuyến mãi → ${maskZbsPhone(msg.phone)}: ${status} (${info.errorCode ?? '-'})`);
    }
    return status;
  }

  /** SENDING campaigns with nothing left in the queue → COMPLETED. */
  async completeFinishedCampaigns(): Promise<number> {
    const sending = await this.campaignModel.find({ status: ZbsCampaignStatus.SENDING }).select('_id').lean().exec();
    let completed = 0;
    for (const c of sending) {
      const left = await this.messageModel
        .exists({ campaignId: c._id, status: { $in: [...QUEUED, MsgStatus.PROCESSING] } })
        .exec();
      if (left) continue;
      const res = await this.campaignModel
        .updateOne({ _id: c._id, status: ZbsCampaignStatus.SENDING }, { $set: { status: ZbsCampaignStatus.COMPLETED, completedAt: new Date() } })
        .exec();
      completed += res.modifiedCount;
    }
    return completed;
  }

  // ─── Admin views ─────────────────────────────────────────────────────────

  async status() {
    const cfg = this.configService.get();
    const mapping = this.configService.promotionParamMapping(cfg);
    const now = new Date();
    const [template, acceptedToday, acceptedThisMonth] = await Promise.all([
      this.templates.view(this.templateTarget(cfg), mapping.mapping.map((m) => ({ param: m.param, source: m.source ?? 'const' })), mapping.errors),
      this.messageModel.countDocuments({ acceptedAt: { $gte: vnPeriodStart(now, 'day') } }).exec(),
      this.messageModel.countDocuments({ acceptedAt: { $gte: vnPeriodStart(now, 'month') } }).exec(),
    ]);
    return {
      config: this.configService.promotionReadiness(),
      template,
      stats: {
        acceptedToday,
        acceptedThisMonth,
        dailySendLimit: cfg.promotionDailySendLimit,
        inSendWindow: inVnSendWindow(now, cfg.promotionSendStartHour, cfg.promotionSendEndHour),
      },
    };
  }

  private async countsByCampaign(ids: Types.ObjectId[]): Promise<Map<string, Record<string, number>>> {
    const rows = await this.messageModel
      .aggregate<{ _id: { c: Types.ObjectId; s: string }; n: number }>([
        { $match: { campaignId: { $in: ids } } },
        { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } },
      ])
      .exec();
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const key = r._id.c.toString();
      out.set(key, { ...(out.get(key) ?? {}), [r._id.s]: r.n });
    }
    return out;
  }

  private campaignView(c: ZbsCampaign, counts: Record<string, number> = {}) {
    const accepted = (counts[MsgStatus.ACCEPTED] ?? 0) + (counts[MsgStatus.DELIVERED] ?? 0);
    return {
      _id: c._id.toString(),
      name: c.name,
      promotionId: c.promotionId.toString(),
      couponId: c.couponId.toString(),
      couponCode: c.couponCode,
      promotionName: c.promotionName,
      audience: c.audience,
      templateId: c.templateId,
      status: c.status,
      pauseCode: c.pauseCode,
      pauseReason: c.pauseReason,
      recipientCount: c.recipientCount,
      exclusions: c.exclusions,
      warnings: c.warnings ?? [],
      counts,
      accepted,
      costEstimate:
        c.unitPriceVnd !== undefined && c.unitPriceVnd !== null
          ? {
              unitPriceVnd: c.unitPriceVnd,
              maxVnd: c.unitPriceVnd * c.recipientCount,
              acceptedVnd: c.unitPriceVnd * accepted,
              note: 'Ước tính = số tin × đơn giá template. Không phải số tiền trên hóa đơn ZBS.',
            }
          : null,
      draftExpiresAt: c.status === ZbsCampaignStatus.DRAFT ? new Date(new Date(c.createdAt).getTime() + ZBS_CAMPAIGN_DRAFT_TTL_MS) : null,
      createdAt: c.createdAt,
      confirmedAt: c.confirmedAt,
      completedAt: c.completedAt,
      cancelledAt: c.cancelledAt,
    };
  }

  async listCampaigns(page: number, limit: number) {
    page = Math.max(1, page);
    limit = Math.min(100, Math.max(1, limit));
    const [rows, total] = await Promise.all([
      this.campaignModel.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.campaignModel.countDocuments().exec(),
    ]);
    const counts = await this.countsByCampaign(rows.map((r) => r._id));
    return { data: rows.map((r) => this.campaignView(r, counts.get(r._id.toString()))), total, page, limit };
  }

  async getCampaign(id: string) {
    const c = await this.findCampaign(id);
    const counts = await this.countsByCampaign([c._id]);
    return this.campaignView(c.toObject() as ZbsCampaign, counts.get(c._id.toString()));
  }

  async listMessages(id: string, query: { status?: MsgStatus; page: number; limit: number }) {
    const c = await this.findCampaign(id);
    const filter: Record<string, unknown> = { campaignId: c._id };
    if (query.status) filter.status = query.status;
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const [rows, total] = await Promise.all([
      this.messageModel.find(filter).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.messageModel.countDocuments(filter).exec(),
    ]);
    return {
      data: rows.map((m) => ({
        _id: m._id.toString(),
        userId: m.userId.toString(),
        recipient: maskZbsPhone(m.phone),
        status: m.status,
        trackingId: m.trackingId,
        attemptCount: m.attemptCount,
        maxAttempts: m.maxAttempts,
        nextAttemptAt: m.nextAttemptAt,
        providerMessageId: m.providerMessageId,
        providerDeliveryStatus: m.providerDeliveryStatus,
        errorClass: m.errorClass,
        lastErrorCode: m.lastErrorCode,
        lastErrorMessage: m.lastErrorMessage,
        acceptedAt: m.acceptedAt,
        deliveredAt: m.deliveredAt,
        processedAt: m.processedAt,
        deliveryCheckable: !!m.providerMessageId && m.status === MsgStatus.ACCEPTED,
      })),
      total,
      page,
      limit,
    };
  }

  /** Message-status API for one ACCEPTED promotion message; only status 1 → DELIVERED. */
  async checkDelivery(messageId: string, staffId?: string) {
    if (!Types.ObjectId.isValid(messageId)) throw new BadRequestException('Mã tin không hợp lệ');
    const msg = await this.messageModel.findById(messageId).exec();
    if (!msg) throw new NotFoundException('Không tìm thấy tin');
    if (!msg.providerMessageId || ![MsgStatus.ACCEPTED, MsgStatus.DELIVERED].includes(msg.status)) {
      throw new BadRequestException('Chỉ kiểm tra được tin đã được Zalo nhận (có msg_id)');
    }
    const token = await this.auth.getAccessToken();
    if (!token.ok) throw new BadRequestException(`Không lấy được access token: ${token.errorCode}`);
    let res = await this.client.getMessageStatus(token.accessToken, msg.providerMessageId, msg.phone);
    if (!res.ok && res.kind === 'TOKEN_INVALID') {
      const renewed = await this.auth.handleRejectedAccessToken(token.accessToken);
      if (!renewed.ok) throw new BadRequestException(`Không lấy được access token: ${renewed.errorCode}`);
      res = await this.client.getMessageStatus(renewed.accessToken, msg.providerMessageId, msg.phone);
    }
    if (!res.ok) return { ok: false, errorCode: res.errorCode, description: res.description };
    const providerStatus = toInt(res.data.status);
    const $set: Record<string, unknown> = { deliveryCheckedAt: new Date() };
    if (providerStatus !== undefined) $set.providerDeliveryStatus = providerStatus;
    if (providerStatus === 1) {
      $set.status = MsgStatus.DELIVERED;
      $set.deliveredAt = toDateFromMs(res.data.delivery_time) ?? new Date();
    }
    await this.messageModel.updateOne({ _id: msg._id, status: { $in: [MsgStatus.ACCEPTED, MsgStatus.DELIVERED] } }, { $set }).exec();
    if (staffId) {
      await this.auditService.log({
        actorId: staffId,
        actorType: 'staff',
        action: 'ZALO_ZBS_CAMPAIGN_DELIVERY_CHECK',
        module: 'zalo-zbs',
        targetId: messageId,
        afterData: { providerStatus },
      });
    }
    return { ok: true, providerStatus };
  }
}

function attemptEntry(info: { outcome: string; errorCode?: string; httpStatus?: number; durationMs?: number }) {
  return {
    at: new Date(),
    outcome: info.outcome,
    ...(info.errorCode ? { errorCode: info.errorCode } : {}),
    ...(info.httpStatus !== undefined ? { httpStatus: info.httpStatus } : {}),
    ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
  };
}

/** Zalo timestamps are millisecond strings ("1626926349402"). */
function toDateFromMs(v: unknown): Date | undefined {
  const n = toInt(v);
  return n !== undefined && n > 1e12 ? new Date(n) : undefined;
}
