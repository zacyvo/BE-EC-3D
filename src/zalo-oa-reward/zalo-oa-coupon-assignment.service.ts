import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PromotionsService } from '../promotions/promotions.service';
import { CouponItem, DiscountType, PromotionDocument } from '../promotions/schemas/promotion.schema';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import {
  EXPECTED_DISCOUNT_PERCENT,
  GrantStatus,
  IneligibleReason,
  RecipientResolution,
  RewardPhoneSource,
  maskId,
} from './zalo-oa-reward.constants';
import { ZaloOaRewardGrant, ZaloOaRewardGrantDocument } from './schemas/zalo-oa-reward-grant.schema';

/** What the customer may be told about the offer (all from the DB records). */
export interface CampaignOffer {
  promotionId: string;
  couponId: string;
  code: string;
  discountPercent: number;
  minOrderValue: number;
  maxDiscountAmount: number;
  perUserUsageLimit: number;
  endDate: Date;
}

export type CampaignCheck =
  | { ok: true; offer: CampaignOffer; promotion: PromotionDocument; coupon: CouponItem }
  | { ok: false; reason: IneligibleReason };

export interface AssignInput {
  sessionId: Types.ObjectId;
  orderId: Types.ObjectId;
  oaId: string;
  oaUid: string;
  userId: Types.ObjectId;
  resolution: RecipientResolution;
  phone?: string;
  phoneSource: RewardPhoneSource;
}

export type AssignResult =
  | { outcome: 'ASSIGNED'; grant: ZaloOaRewardGrantDocument }
  | { outcome: 'ALREADY_CLAIMED'; grant?: ZaloOaRewardGrantDocument }
  | { outcome: 'NOT_ELIGIBLE'; reason: IneligibleReason };

function toOffer(promotion: PromotionDocument, coupon: CouponItem): CampaignOffer {
  return {
    promotionId: String(promotion._id),
    couponId: String(coupon._id),
    code: coupon.code,
    discountPercent: coupon.value,
    minOrderValue: coupon.minOrderValue,
    maxDiscountAmount: coupon.maxDiscountAmount,
    perUserUsageLimit: coupon.perUserUsageLimit,
    endDate: promotion.endDate,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * Enrolls a resolved recipient in the EXISTING ZALO_OA promotion using the project's own
 * mechanism: a Promotion's coupons are usable by users in `assignedUsers` (or everyone when
 * `assignedToAll`). So "assigning the existing coupon" = adding the user to the program via
 * PromotionsService. No promotion or coupon is ever created; the code shown is read from the
 * DB. Usage limits stay enforced by PromotionsService.validateCoupons at checkout.
 */
@Injectable()
export class ZaloOaCouponAssignmentService {
  private readonly logger = new Logger(ZaloOaCouponAssignmentService.name);

  constructor(
    @InjectModel(ZaloOaRewardGrant.name) private readonly grantModel: Model<ZaloOaRewardGrantDocument>,
    private readonly promotions: PromotionsService,
    private readonly config: ZaloOaRewardConfigService,
  ) {}

  /** findPromotion → findExistingCoupon → validate (active, dates, membership, 20%, limits). */
  async verifyCampaign(now: Date = new Date()): Promise<CampaignCheck> {
    const loaded = await this.load();
    if (!loaded.ok) return loaded;
    const { promotion, coupon } = loaded;
    if (!promotion.isActive) return { ok: false, reason: IneligibleReason.PROMOTION_INACTIVE };
    if (promotion.startDate > now) return { ok: false, reason: IneligibleReason.PROMOTION_NOT_STARTED };
    if (promotion.endDate < now) return { ok: false, reason: IneligibleReason.PROMOTION_EXPIRED };
    if (coupon.type !== DiscountType.PERCENTAGE || coupon.value !== EXPECTED_DISCOUNT_PERCENT) {
      return { ok: false, reason: IneligibleReason.DISCOUNT_MISMATCH };
    }
    if (coupon.totalUsageLimit > 0 && coupon.totalUsedCount >= coupon.totalUsageLimit) {
      return { ok: false, reason: IneligibleReason.COUPON_EXHAUSTED };
    }
    return { ok: true, promotion, coupon, offer: toOffer(promotion, coupon) };
  }

  /** The offer's display conditions, without eligibility checks (e.g. for a reward that was
   * already assigned and has since been used up). */
  async readOffer(): Promise<CampaignOffer | null> {
    const loaded = await this.load();
    return loaded.ok ? toOffer(loaded.promotion, loaded.coupon) : null;
  }

  private async load(): Promise<
    { ok: true; promotion: PromotionDocument; coupon: CouponItem } | { ok: false; reason: IneligibleReason }
  > {
    const cfg = this.config.get();
    let promotion: PromotionDocument;
    try {
      promotion = await this.promotions.findById(cfg.promotionId);
    } catch (err) {
      if (err instanceof NotFoundException) return { ok: false, reason: IneligibleReason.PROMOTION_NOT_FOUND };
      throw err;
    }
    // The coupon is an embedded CouponItem, so "belongs to the promotion" = it is in this array.
    const coupon = (promotion.coupons ?? []).find((c) => String(c._id) === cfg.couponId);
    if (!coupon) return { ok: false, reason: IneligibleReason.COUPON_NOT_IN_PROMOTION };
    return { ok: true, promotion, coupon };
  }

  /** Grant already recorded for this user or this OA identity under the campaign. */
  async findGrant(by: { userId?: Types.ObjectId; oaId?: string; oaUid?: string }): Promise<ZaloOaRewardGrantDocument | null> {
    const cfg = this.config.get();
    if (!Types.ObjectId.isValid(cfg.promotionId)) return null;
    const or: Record<string, unknown>[] = [];
    if (by.userId) or.push({ userId: by.userId });
    if (by.oaId && by.oaUid) or.push({ oaId: by.oaId, oaUid: by.oaUid });
    if (!or.length) return null;
    return this.grantModel.findOne({ promotionId: new Types.ObjectId(cfg.promotionId), $or: or }).exec();
  }

  /** checkExistingEnrollment → assignExistingCoupon → saveRewardHistory, idempotently. */
  async assign(input: AssignInput, attempt = 0): Promise<AssignResult> {
    const existing = await this.findGrant({ userId: input.userId, oaId: input.oaId, oaUid: input.oaUid });
    if (existing) {
      if (existing.status === GrantStatus.PROCESSING) {
        // A previous run crashed between "grant row" and "user added to promotion": finish it.
        const done = await this.complete(existing);
        if (String(existing.sessionId) === String(input.sessionId)) return { outcome: 'ASSIGNED', grant: done };
        return { outcome: 'ALREADY_CLAIMED', grant: done };
      }
      return { outcome: 'ALREADY_CLAIMED', grant: existing };
    }

    const check = await this.verifyCampaign();
    if (!check.ok) return { outcome: 'NOT_ELIGIBLE', reason: check.reason };

    const usage = (check.coupon.usageRecords ?? []).find((r) => String(r.userId) === String(input.userId));
    if (usage && usage.count >= check.coupon.perUserUsageLimit) {
      // Already redeemed this coupon (e.g. assigned by an admin earlier) — nothing to give.
      return { outcome: 'ALREADY_CLAIMED' };
    }

    let grant: ZaloOaRewardGrantDocument;
    try {
      grant = await this.grantModel.create({
        promotionId: check.promotion._id,
        couponId: check.coupon._id,
        oaId: input.oaId,
        oaUid: input.oaUid,
        userId: input.userId,
        resolution: input.resolution,
        ...(input.phone ? { phone: input.phone } : {}),
        phoneSource: input.phoneSource,
        phoneVerified: false,
        sessionId: input.sessionId,
        orderId: input.orderId,
        status: GrantStatus.PROCESSING,
      });
    } catch (err) {
      // Lost a race against another trigger for the same UID/user → re-evaluate once.
      if (isDuplicateKey(err) && attempt === 0) return this.assign(input, 1);
      throw err;
    }
    return { outcome: 'ASSIGNED', grant: await this.complete(grant) };
  }

  private async complete(grant: ZaloOaRewardGrantDocument): Promise<ZaloOaRewardGrantDocument> {
    const promotion = await this.promotions.findById(String(grant.promotionId));
    const coupon = (promotion.coupons ?? []).find((c) => String(c._id) === String(grant.couponId));
    if (!coupon) throw new Error('COUPON_REMOVED_DURING_ASSIGNMENT');
    const viaAll = !!promotion.assignedToAll;
    if (!viaAll) {
      const ok = await this.promotions.assignUserToProgram(String(promotion._id), String(grant.userId));
      if (!ok) throw new Error('PROMOTION_REMOVED_DURING_ASSIGNMENT');
    }
    const updated = await this.grantModel
      .findByIdAndUpdate(
        grant._id,
        {
          $set: {
            status: GrantStatus.ASSIGNED,
            couponCode: coupon.code,
            viaAssignedToAll: viaAll,
            assignedAt: grant.assignedAt ?? new Date(),
          },
        },
        { new: true },
      )
      .exec();
    this.logger.log(`Zalo OA reward: đã gán coupon cho user ${maskId(String(grant.userId))} (OA UID ${maskId(grant.oaUid)})`);
    return updated ?? grant;
  }
}
