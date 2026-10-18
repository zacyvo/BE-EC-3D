import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { RecipientResolution, RewardPhoneSource, maskId } from './zalo-oa-reward.constants';
import { ZaloOaLink, ZaloOaLinkDocument } from './schemas/zalo-oa-link.schema';

export interface RecipientContext {
  oaId: string;
  sessionId: Types.ObjectId;
  /** The logged-in account that placed the order (absent only outside the storefront). */
  sessionUserId?: Types.ObjectId;
  /** Optional phone typed in the modal, already normalized to national 0xxxxxxxxx. */
  rewardPhone?: string;
}

export interface ResolvedRecipient {
  userId: Types.ObjectId;
  resolution: RecipientResolution;
  phone?: string;
  phoneSource: RewardPhoneSource;
  /** The session pointed at someone other than the UID's existing association (Case D). */
  conflict: boolean;
  /** A Guest user was created by this call. */
  createdGuest: boolean;
  blocked: boolean;
}

const GUEST_NAME = 'Khách Zalo OA';

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * resolveRewardRecipient(context, oaUid): decides WHICH Luxe Glow user receives the reward
 * for a verified OA UID, and records the UID association. Idempotent.
 *
 *  A/D. UID already associated → that user, always. The association is never transferred or
 *       overwritten; a different session target is only flagged as a conflict.
 *  B.   Optional reward phone matches a user → that user (promotional association only:
 *       no login, no credential/phone change, phone marked unverified).
 *  C.   Optional reward phone unknown → Guest via the existing UsersService.findOrCreateByPhone
 *       convention (no password → cannot log in).
 *  —    No reward phone → the authenticated account that placed the order (default).
 *  E.   No account and no phone → UID-keyed Guest (UsersService.findOrCreateByExternalBuyer).
 *
 * No phone is ever "verified" here and no fake phone is ever generated.
 */
@Injectable()
export class ZaloOaRecipientService {
  private readonly logger = new Logger(ZaloOaRecipientService.name);

  constructor(
    @InjectModel(ZaloOaLink.name) private readonly linkModel: Model<ZaloOaLinkDocument>,
    private readonly users: UsersService,
  ) {}

  async resolveRewardRecipient(ctx: RecipientContext, oaUid: string, attempt = 0): Promise<ResolvedRecipient> {
    const existing = await this.linkModel.findOne({ oaId: ctx.oaId, oaUid }).exec();
    if (existing) return this.fromExistingLink(ctx, existing);

    const target = await this.resolveTarget(ctx, oaUid);
    try {
      await this.linkModel.create({
        oaId: ctx.oaId,
        oaUid,
        userId: target.user._id,
        resolution: target.resolution,
        ...(target.phone ? { phone: target.phone } : {}),
        phoneSource: target.phoneSource,
        phoneVerified: false,
        sessionId: ctx.sessionId,
      });
    } catch (err) {
      // Another trigger linked this UID first → its association wins.
      if (isDuplicateKey(err) && attempt === 0) return this.resolveRewardRecipient(ctx, oaUid, 1);
      throw err;
    }
    this.logger.log(`Zalo OA: liên kết UID ${maskId(oaUid)} → user ${maskId(String(target.user._id))} (${target.resolution})`);
    return {
      userId: target.user._id,
      resolution: target.resolution,
      phone: target.phone,
      phoneSource: target.phoneSource,
      conflict: false,
      createdGuest: target.createdGuest,
      blocked: !!target.user.isBlocked,
    };
  }

  /** Whether this user already has an OA identity associated (any UID). */
  async findLinkForUser(userId: Types.ObjectId, oaId: string): Promise<ZaloOaLinkDocument | null> {
    return this.linkModel.findOne({ userId, oaId }).exec();
  }

  private async fromExistingLink(ctx: RecipientContext, link: ZaloOaLinkDocument): Promise<ResolvedRecipient> {
    const linked = await this.users.findById(String(link.userId));
    let intended: Types.ObjectId | undefined = ctx.sessionUserId;
    if (ctx.rewardPhone) intended = (await this.users.findByPhone(ctx.rewardPhone))?._id;
    const conflict = !intended || String(intended) !== String(link.userId);
    if (conflict) {
      this.logger.warn(`Zalo OA: UID ${maskId(link.oaUid)} đã liên kết user khác — giữ nguyên liên kết cũ, không chuyển`);
    }
    return {
      userId: link.userId,
      resolution: RecipientResolution.EXISTING_OA_LINK,
      phone: link.phone,
      phoneSource: link.phoneSource,
      conflict,
      createdGuest: false,
      // A deleted (soft) linked user is treated like a blocked one: no reward to a dead account.
      blocked: !linked || !!linked.isBlocked,
    };
  }

  private async resolveTarget(
    ctx: RecipientContext,
    oaUid: string,
  ): Promise<{ user: UserDocument; resolution: RecipientResolution; phone?: string; phoneSource: RewardPhoneSource; createdGuest: boolean }> {
    if (ctx.rewardPhone) {
      const found = await this.users.findByPhone(ctx.rewardPhone);
      if (found) {
        return { user: found, resolution: RecipientResolution.PHONE_MATCH, phone: ctx.rewardPhone, phoneSource: RewardPhoneSource.REWARD_INPUT, createdGuest: false };
      }
      const { user, created } = await this.retryOnDuplicate(() => this.users.findOrCreateByPhone(ctx.rewardPhone!, GUEST_NAME));
      return { user, resolution: created ? RecipientResolution.GUEST_BY_PHONE : RecipientResolution.PHONE_MATCH, phone: ctx.rewardPhone, phoneSource: RewardPhoneSource.REWARD_INPUT, createdGuest: created };
    }
    if (ctx.sessionUserId) {
      const owner = await this.users.findById(String(ctx.sessionUserId));
      if (owner) {
        return {
          user: owner,
          resolution: RecipientResolution.SESSION_ACCOUNT,
          ...(owner.phone ? { phone: owner.phone } : {}),
          phoneSource: owner.phone ? RewardPhoneSource.ACCOUNT : RewardPhoneSource.NONE,
          createdGuest: false,
        };
      }
    }
    const { user, created } = await this.retryOnDuplicate(() => this.users.findOrCreateByExternalBuyer('ZALO_OA', oaUid, GUEST_NAME));
    return { user, resolution: RecipientResolution.GUEST_BY_UID, phoneSource: RewardPhoneSource.NONE, createdGuest: created };
  }

  /** findOrCreate* are find-then-insert; a concurrent insert surfaces as E11000 → re-find. */
  private async retryOnDuplicate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isDuplicateKey(err)) return fn();
      throw err;
    }
  }
}
