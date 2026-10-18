import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument, OrderStatus } from '../orders/schemas/order.schema';
import { normalizeVnPhone } from '../zalo-zbs/zbs-phone';
import { ZaloOaRewardConfigService, ZaloOaRewardConfigSnapshot } from './zalo-oa-reward.config';
import {
  IdentitySource,
  IneligibleReason,
  LINKABLE_STATES,
  LinkMode,
  RewardSessionState,
  maskId,
} from './zalo-oa-reward.constants';
import { isOpaqueRef, newOpaqueRef, newPkceVerifier, sha256Hex } from './zalo-oa-crypto';
import { ZaloOaIdentityService } from './zalo-oa-identity.service';
import { ZaloOaRecipientService } from './zalo-oa-recipient.service';
import { CampaignOffer, ZaloOaCouponAssignmentService } from './zalo-oa-coupon-assignment.service';
import { ZaloOaRewardSession, ZaloOaRewardSessionDocument } from './schemas/zalo-oa-reward-session.schema';
import { ZaloOaFollower, ZaloOaFollowerDocument } from './schemas/zalo-oa-follower.schema';
import { ZaloOaRewardGrantDocument } from './schemas/zalo-oa-reward-grant.schema';

/** What the order owner's browser sees. No other user's data, no ids, no secrets. */
export interface RewardStatusView {
  enabled: boolean;
  state: RewardSessionState;
  reason?: IneligibleReason;
  errorCode?: string;
  offer?: {
    discountPercent: number;
    minOrderValue: number;
    maxDiscountAmount: number;
    endDate: Date;
  };
  oa?: { name: string; url: string };
  linkMode?: LinkMode;
  linkExpiresAt?: Date;
  /** Only once the reward is really assigned (or already held by this same account). */
  couponCode?: string;
  recipient?: { isOrderAccount: boolean; phoneMasked?: string };
  hasRewardPhone?: boolean;
}

export interface PreparedLink {
  connectUrl: string;
  expiresAt: Date;
  status: RewardStatusView;
}

/** Where the customer's browser goes after a Zalo step (backend → 302). */
export type ConnectRedirect = { url: string };

const OAUTH_STATE_TTL_MS = 10 * 60_000; // Zalo authorization codes are valid 10 minutes.
const LEASE_MS = 30_000;
const MAX_PROCESSING_ATTEMPTS = 5;
const PRE_LINK_STATES = new Set<RewardSessionState>([
  ...LINKABLE_STATES,
  RewardSessionState.FOLLOW_PENDING,
]);
const FOLLOW_TIMEOUT_CODE = 'FOLLOW_EVENT_NOT_RECEIVED';

export function maskNationalPhone(p?: string): string | undefined {
  if (!p) return undefined;
  return p.length < 7 ? '***' : `${p.slice(0, 3)}${'*'.repeat(p.length - 5)}${p.slice(-2)}`;
}

/**
 * ZaloOaRewardService: one reward session per storefront order, driven to a reward ONLY by
 * validated evidence:
 *
 *   order success ──► session (opaque ref, hashed) ──► personalized link / QR
 *   Zalo Login (state+PKCE) or Mini App token ──► graph /me (appsecret_proof) ──► app-scoped id
 *   signed OA follow webhook {follower.id = OA UID, user_id_by_app} ──► zalo_oa_followers
 *   join on app-scoped id ──► LINKED ──► resolveRewardRecipient ──► assign existing coupon
 *
 * There is no customer-entered code, no OTP, no phone matching requirement, and no
 * correlation by time, "latest follower/order", display name or client-submitted UID.
 */
@Injectable()
export class ZaloOaRewardService {
  private readonly logger = new Logger(ZaloOaRewardService.name);

  constructor(
    @InjectModel(ZaloOaRewardSession.name) private readonly sessionModel: Model<ZaloOaRewardSessionDocument>,
    @InjectModel(ZaloOaFollower.name) private readonly followerModel: Model<ZaloOaFollowerDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: ZaloOaRewardConfigService,
    private readonly identity: ZaloOaIdentityService,
    private readonly recipients: ZaloOaRecipientService,
    private readonly coupons: ZaloOaCouponAssignmentService,
  ) {}

  // ─── Order owner (JWT) ────────────────────────────────────────────────────────

  /** Called right after checkout. Creates the session if the order is eligible; an existing
   * reward for this account skips the first-time flow (ALREADY_CLAIMED). */
  async openForOrder(userId: string, orderId: string): Promise<RewardStatusView> {
    const cfg = this.config.get();
    if (!cfg.enabled) return { enabled: false, state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.DISABLED };
    const validation = this.config.validate(cfg);
    if (!validation.valid) {
      this.logger.warn(`Zalo OA reward bật nhưng cấu hình chưa hợp lệ: ${validation.errors.join('; ')}`);
      return { enabled: false, state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.CONFIG_INVALID };
    }
    const order = await this.findOwnedOrder(userId, orderId);
    const existing = await this.sessionModel.findOne({ orderId: order._id }).exec();
    if (existing) return this.statusOf(existing, cfg, true);

    const ineligible = this.orderIneligibility(order, cfg);
    if (ineligible) return this.ineligibleView(ineligible, cfg);

    const userOid = new Types.ObjectId(userId);
    const grant = await this.coupons.findGrant({ userId: userOid });
    if (grant) return this.claimedView(grant, userOid, cfg);

    const check = await this.coupons.verifyCampaign();
    if (!check.ok) return this.ineligibleView(check.reason, cfg);

    let session: ZaloOaRewardSessionDocument;
    try {
      session = await this.sessionModel.create({ orderId: order._id, userId: userOid, state: RewardSessionState.ELIGIBLE });
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
      session = (await this.sessionModel.findOne({ orderId: order._id }).exec())!;
    }
    return this.statusOf(session, cfg, false, check.offer);
  }

  /** Issues a fresh personalized link (QR + button). The previous reference stops working. */
  async prepareLink(userId: string, orderId: string): Promise<PreparedLink> {
    const cfg = this.requireActiveConfig();
    const session = await this.findOwnedSession(userId, orderId);
    await this.applyTimeTransitions(session, cfg);
    if (!LINKABLE_STATES.has(session.state)) {
      throw new ConflictException('Phiên nhận quà không còn ở trạng thái có thể kết nối Zalo');
    }
    const order = await this.findOwnedOrder(userId, orderId);
    const ineligible = this.orderIneligibility(order, cfg);
    const check = ineligible ? null : await this.coupons.verifyCampaign();
    if (ineligible || !check?.ok) {
      session.state = RewardSessionState.NOT_ELIGIBLE;
      session.reason = ineligible ?? (check && !check.ok ? check.reason : undefined);
      await session.save();
      throw new ConflictException('Đơn hàng không còn đủ điều kiện nhận ưu đãi');
    }

    const ref = newOpaqueRef();
    const expiresAt = new Date(Date.now() + cfg.linkTtlMinutes * 60_000);
    session.refHash = sha256Hex(ref);
    session.expiresAt = expiresAt;
    session.state = RewardSessionState.AWAITING_ZALO;
    session.oauthStateHash = undefined;
    session.oauthCodeVerifier = undefined;
    session.oauthStateExpiresAt = undefined;
    session.dismissedAt = undefined;
    await session.save();
    return { connectUrl: this.connectUrl(ref, cfg), expiresAt, status: await this.statusOf(session, cfg, false, check.offer) };
  }

  /** Optional reward phone. Accepted as typed (format-validated only) — no OTP, no matching
   * against the checkout phone. Empty clears it. Locked once the OA identity is linked. */
  async setRewardPhone(userId: string, orderId: string, rawPhone: string | null | undefined): Promise<RewardStatusView> {
    const cfg = this.requireActiveConfig();
    const session = await this.findOwnedSession(userId, orderId);
    if (!PRE_LINK_STATES.has(session.state)) {
      throw new ConflictException('Không thể đổi số điện thoại sau khi đã liên kết Zalo');
    }
    const input = String(rawPhone ?? '').trim();
    if (!input) {
      session.rewardPhone = undefined;
    } else {
      const n = normalizeVnPhone(input);
      if (!n.ok) throw new BadRequestException('Số điện thoại không hợp lệ (VD: 0912345678)');
      session.rewardPhone = `0${n.phone.slice(2)}`;
    }
    await session.save();
    return this.statusOf(session, cfg, false);
  }

  /** Polled by the modal. Applies expiry/timeouts and opportunistically resumes processing,
   * so a missed in-process trigger can never strand a session. */
  async getStatus(userId: string, orderId: string): Promise<RewardStatusView> {
    const cfg = this.config.get();
    const session = await this.findOwnedSession(userId, orderId);
    return this.statusOf(session, cfg, true);
  }

  async dismiss(userId: string, orderId: string): Promise<RewardStatusView> {
    const cfg = this.config.get();
    const session = await this.findOwnedSession(userId, orderId);
    session.dismissedAt = new Date();
    await session.save();
    return this.statusOf(session, cfg, false);
  }

  // ─── Public Zalo-side entry points ───────────────────────────────────────────

  /** GET /zalo-oa-reward/connect?rs=… (QR / button target, social_login mode). Starts Zalo
   * Login with a fresh single-use state + PKCE verifier bound to this session. */
  async beginConnect(ref: unknown): Promise<ConnectRedirect> {
    const cfg = this.config.get();
    if (!cfg.enabled || !this.config.validate(cfg).valid) return this.resultRedirect('unavailable', cfg);
    if (!isOpaqueRef(ref)) return this.resultRedirect('invalid', cfg);
    const session = await this.sessionModel.findOne({ refHash: sha256Hex(ref) }).exec();
    if (!session) return this.resultRedirect('invalid', cfg);
    await this.applyTimeTransitions(session, cfg);
    if (session.state === RewardSessionState.EXPIRED) return this.resultRedirect('expired', cfg);
    if (!LINKABLE_STATES.has(session.state)) return this.redirectFor(session, cfg);
    if (cfg.linkMode === LinkMode.MINI_APP) return { url: this.miniAppUrl(ref, cfg) };

    const state = newOpaqueRef();
    const verifier = newPkceVerifier();
    session.oauthStateHash = sha256Hex(state);
    session.oauthCodeVerifier = verifier;
    session.oauthStateExpiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
    session.state = RewardSessionState.IDENTITY_PENDING;
    await session.save();
    return { url: this.identity.buildPermissionUrl(state, verifier, cfg) };
  }

  /** GET /zalo-oa-reward/oauth/callback?code&state — Zalo redirects here after "Cho phép". */
  async handleOAuthCallback(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<ConnectRedirect> {
    const cfg = this.config.get();
    if (!cfg.enabled || !this.config.validate(cfg).valid) return this.resultRedirect('unavailable', cfg);
    if (!isOpaqueRef(query.state)) return this.resultRedirect('invalid', cfg);
    // Single-use: the state is consumed (and the verifier read) atomically.
    const session = await this.sessionModel
      .findOneAndUpdate(
        { oauthStateHash: sha256Hex(query.state) },
        { $unset: { oauthStateHash: 1, oauthCodeVerifier: 1, oauthStateExpiresAt: 1 } },
        { new: false },
      )
      .select('+oauthCodeVerifier')
      .exec();
    if (!session) return this.resultRedirect('invalid', cfg);
    const verifier = session.oauthCodeVerifier;
    const reloaded = (await this.sessionModel.findById(session._id).exec())!;

    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || !verifier) {
      // The customer pressed "Từ chối" (or Zalo returned an error): back to waiting.
      if (reloaded.state === RewardSessionState.IDENTITY_PENDING) {
        reloaded.state = RewardSessionState.AWAITING_ZALO;
        await reloaded.save();
      }
      return this.resultRedirect('denied', cfg);
    }
    if (!session.oauthStateExpiresAt || session.oauthStateExpiresAt < new Date()) return this.resultRedirect('expired', cfg);

    const result = await this.identity.verifyAuthorizationCode(code, verifier);
    if (!result.ok) {
      this.logger.warn(`Zalo OA reward: xác thực Zalo Login thất bại (${result.code}) cho session ${maskId(String(session._id))}`);
      if (reloaded.state === RewardSessionState.IDENTITY_PENDING) {
        reloaded.state = RewardSessionState.AWAITING_ZALO;
        await reloaded.save();
      }
      return this.resultRedirect('error', cfg);
    }
    const bound = await this.bindIdentity(reloaded, result.zaloAppUserId, IdentitySource.SOCIAL_LOGIN, cfg);
    if (!bound.ok) return this.resultRedirect(bound.result, cfg);
    return this.redirectFor(bound.session, cfg);
  }

  /** POST /zalo-oa-reward/mini-app/identity — called by a Luxe Glow Zalo Mini App opened from
   * the personalized link, with its zmp-sdk getAccessToken() token. */
  async bindMiniAppIdentity(ref: unknown, accessToken: unknown): Promise<{ state: RewardSessionState; next: 'FOLLOW_OA' | 'DONE' | 'NONE' }> {
    const cfg = this.config.get();
    if (!cfg.enabled || !this.config.validate(cfg).valid || cfg.linkMode !== LinkMode.MINI_APP) {
      throw new NotFoundException('Không khả dụng');
    }
    if (!isOpaqueRef(ref) || typeof accessToken !== 'string') throw new BadRequestException('Thiếu thông tin xác thực');
    const session = await this.sessionModel.findOne({ refHash: sha256Hex(ref) }).exec();
    if (!session) throw new NotFoundException('Phiên không tồn tại');
    await this.applyTimeTransitions(session, cfg);
    if (session.state === RewardSessionState.EXPIRED) throw new ConflictException('Phiên đã hết hạn');

    const result = await this.identity.verifyUserAccessToken(accessToken);
    if (!result.ok) throw new BadRequestException('Không xác thực được tài khoản Zalo');
    const bound = await this.bindIdentity(session, result.zaloAppUserId, IdentitySource.MINI_APP, cfg);
    if (!bound.ok) throw new ConflictException('Phiên đã liên kết với tài khoản Zalo khác');
    const s = bound.session.state;
    return { state: s, next: s === RewardSessionState.FOLLOW_PENDING ? 'FOLLOW_OA' : s === RewardSessionState.REWARD_ASSIGNED || s === RewardSessionState.ALREADY_CLAIMED ? 'DONE' : 'NONE' };
  }

  /** Called by the webhook handler after a signed follow event updated the follower map. */
  async onFollowerUpdated(follower: { userIdByApp: string; isFollower: boolean }): Promise<void> {
    if (!follower.isFollower) return;
    const sessions = await this.sessionModel
      .find({
        zaloAppUserId: follower.userIdByApp,
        $or: [
          { state: RewardSessionState.FOLLOW_PENDING },
          // A follow that arrives after the modal gave up is still trustworthy evidence.
          { state: RewardSessionState.UNSUPPORTED_LINKING, errorCode: FOLLOW_TIMEOUT_CODE },
        ],
      })
      .select('_id')
      .limit(20)
      .exec();
    for (const s of sessions) {
      await this.advance(s._id).catch((err) =>
        this.logger.error(`Zalo OA reward: xử lý session ${maskId(String(s._id))} lỗi: ${(err as Error).message}`),
      );
    }
  }

  // ─── Core state machine ──────────────────────────────────────────────────────

  private async bindIdentity(
    session: ZaloOaRewardSessionDocument,
    zaloAppUserId: string,
    source: IdentitySource,
    cfg: ZaloOaRewardConfigSnapshot,
  ): Promise<{ ok: true; session: ZaloOaRewardSessionDocument } | { ok: false; result: string }> {
    if (session.zaloAppUserId && session.zaloAppUserId !== zaloAppUserId) {
      // A session binds to exactly one Zalo identity, once.
      this.logger.warn(`Zalo OA reward: session ${maskId(String(session._id))} đã gắn danh tính Zalo khác — từ chối`);
      return { ok: false, result: 'conflict' };
    }
    if (!session.zaloAppUserId) {
      const updated = await this.sessionModel
        .findOneAndUpdate(
          { _id: session._id, zaloAppUserId: { $exists: false } },
          {
            $set: {
              zaloAppUserId,
              identitySource: source,
              identityVerifiedAt: new Date(),
              followPendingSince: new Date(),
              state: RewardSessionState.FOLLOW_PENDING,
            },
          },
          { new: true },
        )
        .exec();
      if (!updated) {
        const current = (await this.sessionModel.findById(session._id).exec())!;
        if (current.zaloAppUserId !== zaloAppUserId) return { ok: false, result: 'conflict' };
      }
    }
    await this.advance(session._id);
    const fresh = (await this.sessionModel.findById(session._id).exec())!;
    await this.applyTimeTransitions(fresh, cfg);
    return { ok: true, session: fresh };
  }

  /** FOLLOW_PENDING → LINKED → REWARD_PROCESSING → terminal, under a short lease. */
  private async advance(sessionId: Types.ObjectId): Promise<void> {
    const now = new Date();
    const session = await this.sessionModel
      .findOneAndUpdate(
        { _id: sessionId, $or: [{ processingLeaseUntil: { $exists: false } }, { processingLeaseUntil: { $lt: now } }] },
        { $set: { processingLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
        { new: true },
      )
      .exec();
    if (!session) return; // another trigger is processing it right now
    const cfg = this.config.get();
    try {
      const followWaiting =
        session.state === RewardSessionState.FOLLOW_PENDING ||
        (session.state === RewardSessionState.UNSUPPORTED_LINKING && session.errorCode === FOLLOW_TIMEOUT_CODE);
      if (followWaiting && session.zaloAppUserId) {
        const follower = await this.followerModel
          .findOne({ oaId: cfg.oaId, appId: cfg.appId, userIdByApp: session.zaloAppUserId, isFollower: true })
          .exec();
        if (!follower) return;
        session.oaId = follower.oaId;
        session.oaUid = follower.oaUid;
        session.linkedAt = new Date();
        session.state = RewardSessionState.LINKED;
        session.errorCode = undefined;
        await session.save();
        this.logger.log(`Zalo OA reward: session ${maskId(String(session._id))} đã liên kết OA UID ${maskId(follower.oaUid)}`);
      }
      if (session.state === RewardSessionState.LINKED || session.state === RewardSessionState.REWARD_PROCESSING) {
        await this.processReward(session);
      }
    } finally {
      await this.sessionModel.updateOne({ _id: sessionId }, { $unset: { processingLeaseUntil: 1 } }).exec();
    }
  }

  private async processReward(session: ZaloOaRewardSessionDocument): Promise<void> {
    session.state = RewardSessionState.REWARD_PROCESSING;
    await session.save();
    try {
      const recipient = await this.recipients.resolveRewardRecipient(
        { oaId: session.oaId!, sessionId: session._id, sessionUserId: session.userId, rewardPhone: session.rewardPhone },
        session.oaUid!,
      );
      session.recipientUserId = recipient.userId;
      session.recipientResolution = recipient.resolution;
      session.recipientPhoneSource = recipient.phoneSource;
      session.recipientConflict = recipient.conflict;
      if (recipient.blocked) {
        this.finish(session, RewardSessionState.NOT_ELIGIBLE, IneligibleReason.RECIPIENT_BLOCKED);
        await session.save();
        return;
      }
      const result = await this.coupons.assign({
        sessionId: session._id,
        orderId: session.orderId,
        oaId: session.oaId!,
        oaUid: session.oaUid!,
        userId: recipient.userId,
        resolution: recipient.resolution,
        phone: recipient.phone,
        phoneSource: recipient.phoneSource,
      });
      if (result.outcome === 'ASSIGNED') {
        session.grantId = result.grant._id;
        this.finish(session, RewardSessionState.REWARD_ASSIGNED);
      } else if (result.outcome === 'ALREADY_CLAIMED') {
        if (result.grant) session.grantId = result.grant._id;
        this.finish(session, RewardSessionState.ALREADY_CLAIMED);
      } else {
        this.finish(session, RewardSessionState.NOT_ELIGIBLE, result.reason);
      }
      await session.save();
    } catch (err) {
      session.processingAttempts = (session.processingAttempts ?? 0) + 1;
      if (session.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
        session.state = RewardSessionState.ERROR;
        session.errorCode = 'REWARD_PROCESSING_FAILED';
      }
      await session.save();
      this.logger.error(`Zalo OA reward: gán ưu đãi lỗi (lần ${session.processingAttempts}): ${(err as Error).message}`);
    }
  }

  private finish(session: ZaloOaRewardSessionDocument, state: RewardSessionState, reason?: IneligibleReason): void {
    session.state = state;
    session.reason = reason;
    session.completedAt = new Date();
    session.refHash = undefined; // the link is useless from now on
  }

  /** Expiry of an unused link and the follow-event timeout. */
  private async applyTimeTransitions(session: ZaloOaRewardSessionDocument, cfg: ZaloOaRewardConfigSnapshot): Promise<void> {
    const now = Date.now();
    if (
      (session.state === RewardSessionState.AWAITING_ZALO || session.state === RewardSessionState.IDENTITY_PENDING) &&
      session.expiresAt &&
      session.expiresAt.getTime() < now
    ) {
      session.state = RewardSessionState.EXPIRED;
      await session.save();
    } else if (
      session.state === RewardSessionState.FOLLOW_PENDING &&
      session.followPendingSince &&
      session.followPendingSince.getTime() + cfg.followTimeoutMinutes * 60_000 < now
    ) {
      // No signed follow event arrived. Typical cause: the account ALREADY followed the OA,
      // so Zalo sends nothing. We do not guess — the modal says so honestly.
      session.state = RewardSessionState.UNSUPPORTED_LINKING;
      session.errorCode = FOLLOW_TIMEOUT_CODE;
      await session.save();
    }
  }

  // ─── Views & helpers ─────────────────────────────────────────────────────────

  private async statusOf(
    session: ZaloOaRewardSessionDocument,
    cfg: ZaloOaRewardConfigSnapshot,
    resume: boolean,
    knownOffer?: CampaignOffer,
  ): Promise<RewardStatusView> {
    if (resume) {
      if (
        session.state === RewardSessionState.FOLLOW_PENDING ||
        session.state === RewardSessionState.LINKED ||
        (session.state === RewardSessionState.REWARD_PROCESSING &&
          (!session.processingLeaseUntil || session.processingLeaseUntil < new Date()))
      ) {
        await this.advance(session._id);
        session = (await this.sessionModel.findById(session._id).exec())!;
      }
      await this.applyTimeTransitions(session, cfg);
    }
    const offer = knownOffer ?? (await this.coupons.readOffer());
    const view: RewardStatusView = {
      enabled: cfg.enabled,
      state: session.state,
      ...(session.reason ? { reason: session.reason } : {}),
      ...(session.errorCode ? { errorCode: session.errorCode } : {}),
      ...(offer ? { offer: pickOffer(offer) } : {}),
      oa: { name: cfg.oaName, url: cfg.oaUrl },
      linkMode: cfg.linkMode,
      ...(session.expiresAt && LINKABLE_STATES.has(session.state) ? { linkExpiresAt: session.expiresAt } : {}),
      hasRewardPhone: !!session.rewardPhone,
    };
    if (session.state === RewardSessionState.REWARD_ASSIGNED || session.state === RewardSessionState.ALREADY_CLAIMED) {
      const grant = await this.coupons.findGrant({ userId: session.recipientUserId ?? session.userId, oaId: session.oaId, oaUid: session.oaUid });
      // Show the code only to the account it was granted to, or to the session that granted it.
      if (grant?.couponCode && (String(grant.userId) === String(session.userId) || String(grant.sessionId) === String(session._id))) {
        view.couponCode = grant.couponCode;
        view.recipient = {
          isOrderAccount: String(grant.userId) === String(session.userId),
          ...(String(grant.userId) !== String(session.userId) ? { phoneMasked: maskNationalPhone(grant.phone) } : {}),
        };
      }
    }
    return view;
  }

  private async claimedView(grant: ZaloOaRewardGrantDocument, userId: Types.ObjectId, cfg: ZaloOaRewardConfigSnapshot): Promise<RewardStatusView> {
    const offer = await this.coupons.readOffer();
    return {
      enabled: true,
      state: RewardSessionState.ALREADY_CLAIMED,
      ...(offer ? { offer: pickOffer(offer) } : {}),
      oa: { name: cfg.oaName, url: cfg.oaUrl },
      ...(grant.couponCode && String(grant.userId) === String(userId)
        ? { couponCode: grant.couponCode, recipient: { isOrderAccount: true } }
        : {}),
    };
  }

  private ineligibleView(reason: IneligibleReason, cfg: ZaloOaRewardConfigSnapshot): RewardStatusView {
    return { enabled: cfg.enabled, state: RewardSessionState.NOT_ELIGIBLE, reason };
  }

  private orderIneligibility(order: OrderDocument, cfg: ZaloOaRewardConfigSnapshot): IneligibleReason | null {
    if (order.createdByAdmin || order.externalRef) return IneligibleReason.ORDER_NOT_STOREFRONT;
    if (order.status === OrderStatus.CANCELLED) return IneligibleReason.ORDER_CANCELLED;
    if (Date.now() - new Date(order.createdAt).getTime() > cfg.orderMaxAgeHours * 3600_000) return IneligibleReason.ORDER_TOO_OLD;
    return null;
  }

  private async findOwnedOrder(userId: string, orderId: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(userId)) throw new NotFoundException('Không tìm thấy đơn hàng');
    const order = await this.orderModel
      .findOne({ _id: new Types.ObjectId(orderId), userId: new Types.ObjectId(userId) })
      .select('_id userId status createdAt createdByAdmin externalRef')
      .exec();
    // Same 404 for "not yours" and "does not exist" — no order enumeration.
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return order;
  }

  private async findOwnedSession(userId: string, orderId: string): Promise<ZaloOaRewardSessionDocument> {
    if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(userId)) throw new NotFoundException('Không tìm thấy phiên nhận quà');
    const session = await this.sessionModel
      .findOne({ orderId: new Types.ObjectId(orderId), userId: new Types.ObjectId(userId) })
      .exec();
    if (!session) throw new NotFoundException('Không tìm thấy phiên nhận quà');
    return session;
  }

  private requireActiveConfig(): ZaloOaRewardConfigSnapshot {
    const cfg = this.config.get();
    if (!cfg.enabled || !this.config.validate(cfg).valid) throw new NotFoundException('Chương trình chưa được kích hoạt');
    return cfg;
  }

  private connectUrl(ref: string, cfg: ZaloOaRewardConfigSnapshot): string {
    if (cfg.linkMode === LinkMode.MINI_APP) return this.miniAppUrl(ref, cfg);
    return `${cfg.publicApiBaseUrl}/zalo-oa-reward/connect?rs=${encodeURIComponent(ref)}`;
  }

  /** Mini App deep link (docs: https://zalo.me/s/<miniAppId>/…, utm_source=zalo-qr for QR). */
  private miniAppUrl(ref: string, cfg: ZaloOaRewardConfigSnapshot): string {
    return `https://zalo.me/s/${cfg.miniAppId}/?utm_source=zalo-qr&rs=${encodeURIComponent(ref)}`;
  }

  private redirectFor(session: ZaloOaRewardSessionDocument, cfg: ZaloOaRewardConfigSnapshot): ConnectRedirect {
    switch (session.state) {
      case RewardSessionState.FOLLOW_PENDING:
        // Identity verified — the last step is following the OA in Zalo.
        return { url: cfg.oaUrl };
      case RewardSessionState.REWARD_ASSIGNED:
        return this.resultRedirect('done', cfg);
      case RewardSessionState.ALREADY_CLAIMED:
        return this.resultRedirect('claimed', cfg);
      case RewardSessionState.NOT_ELIGIBLE:
        return this.resultRedirect('ineligible', cfg);
      case RewardSessionState.UNSUPPORTED_LINKING:
        return this.resultRedirect('unsupported', cfg);
      case RewardSessionState.LINKED:
      case RewardSessionState.REWARD_PROCESSING:
        return this.resultRedirect('processing', cfg);
      default:
        return this.resultRedirect('error', cfg);
    }
  }

  private resultRedirect(result: string, cfg: ZaloOaRewardConfigSnapshot): ConnectRedirect {
    const base = cfg.frontendUrl || '';
    return { url: `${base}/zalo-reward?result=${encodeURIComponent(result)}` };
  }
}

function pickOffer(o: CampaignOffer): NonNullable<RewardStatusView['offer']> {
  return { discountPercent: o.discountPercent, minOrderValue: o.minOrderValue, maxDiscountAmount: o.maxDiscountAmount, endDate: o.endDate };
}

