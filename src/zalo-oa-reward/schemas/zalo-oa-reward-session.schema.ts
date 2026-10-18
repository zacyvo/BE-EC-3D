import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  IdentitySource,
  IneligibleReason,
  RecipientResolution,
  RewardPhoneSource,
  RewardSessionState,
} from '../zalo-oa-reward.constants';

export type ZaloOaRewardSessionDocument = ZaloOaRewardSession & Document;

/**
 * One reward session per storefront order. The only things that ever cross into Zalo are
 * opaque random values (the connect reference and the OAuth `state`); both are stored as
 * SHA-256 hashes, never in clear. No order id, phone or secret goes into a URL.
 */
@Schema({ timestamps: true, collection: 'zalo_oa_reward_sessions' })
export class ZaloOaRewardSession {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Order', required: true }) orderId: Types.ObjectId;
  /** The authenticated account that placed the order (the only one allowed to read it). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(RewardSessionState) }) state: RewardSessionState;
  @Prop({ enum: Object.values(IneligibleReason) }) reason?: IneligibleReason;
  /** Short machine code for ERROR / UNSUPPORTED_LINKING (no PII). */
  @Prop() errorCode?: string;

  /** sha256(connect reference) — the reference rotates every time a link is issued. */
  @Prop() refHash?: string;
  /** Linking window of the current reference. */
  @Prop() expiresAt?: Date;

  /** sha256(OAuth state) for the in-flight Zalo Login (single-use, 10 min). */
  @Prop() oauthStateHash?: string;
  /** PKCE code_verifier for that login — needed once at code exchange, then cleared. */
  @Prop({ select: false }) oauthCodeVerifier?: string;
  @Prop() oauthStateExpiresAt?: Date;

  /** Server-verified app-scoped Zalo user id (graph /me). Bound once, never rebound. */
  @Prop() zaloAppUserId?: string;
  @Prop({ enum: Object.values(IdentitySource) }) identitySource?: IdentitySource;
  @Prop() identityVerifiedAt?: Date;
  @Prop() followPendingSince?: Date;

  /** OA-scoped UID, taken only from a signed follow webhook for zaloAppUserId. */
  @Prop() oaId?: string;
  @Prop() oaUid?: string;
  @Prop() linkedAt?: Date;

  /** Optional phone typed in the modal — national format (0xxxxxxxxx), NEVER verified. */
  @Prop() rewardPhone?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' }) recipientUserId?: Types.ObjectId;
  @Prop({ enum: Object.values(RecipientResolution) }) recipientResolution?: RecipientResolution;
  @Prop({ enum: Object.values(RewardPhoneSource) }) recipientPhoneSource?: RewardPhoneSource;
  /** The session asked for a different recipient than the UID's existing association. */
  @Prop({ default: false }) recipientConflict: boolean;
  @Prop({ type: Types.ObjectId, ref: 'ZaloOaRewardGrant' }) grantId?: Types.ObjectId;

  /** Short in-process lease so concurrent triggers (webhook, poll) don't double-process. */
  @Prop() processingLeaseUntil?: Date;
  /** Failed reward-processing attempts (transient errors are retried on the next trigger). */
  @Prop({ default: 0 }) processingAttempts: number;
  @Prop() dismissedAt?: Date;
  @Prop() completedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZaloOaRewardSessionSchema = SchemaFactory.createForClass(ZaloOaRewardSession);
ZaloOaRewardSessionSchema.index({ orderId: 1 }, { unique: true });
ZaloOaRewardSessionSchema.index({ refHash: 1 }, { unique: true, sparse: true });
ZaloOaRewardSessionSchema.index({ oauthStateHash: 1 }, { unique: true, sparse: true });
ZaloOaRewardSessionSchema.index({ zaloAppUserId: 1, state: 1 });
ZaloOaRewardSessionSchema.index({ userId: 1, createdAt: -1 });
