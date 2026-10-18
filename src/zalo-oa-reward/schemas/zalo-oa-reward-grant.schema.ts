import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { GrantStatus, RecipientResolution, RewardPhoneSource } from '../zalo-oa-reward.constants';

export type ZaloOaRewardGrantDocument = ZaloOaRewardGrant & Document;

/**
 * Reward history + idempotency guard. Two unique keys make a second grant impossible:
 *   {promotionId, oaId, oaUid} — one reward per Zalo OA identity per campaign
 *   {promotionId, userId}      — one reward per user per campaign (across orders/phones)
 * The row is inserted (PROCESSING) BEFORE the user is added to the promotion, so a crash in
 * between is resumed, never duplicated. The existing master coupon is referenced, not copied.
 */
@Schema({ timestamps: true, collection: 'zalo_oa_reward_grants' })
export class ZaloOaRewardGrant {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Promotion', required: true }) promotionId: Types.ObjectId;
  /** Embedded CouponItem _id inside the promotion. */
  @Prop({ type: Types.ObjectId, required: true }) couponId: Types.ObjectId;
  /** Snapshot of the code read from the DB at assignment time (never invented). */
  @Prop() couponCode?: string;

  @Prop({ required: true }) oaId: string;
  @Prop({ required: true }) oaUid: string;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;
  @Prop({ required: true, enum: Object.values(RecipientResolution) }) resolution: RecipientResolution;
  @Prop() phone?: string;
  @Prop({ required: true, enum: Object.values(RewardPhoneSource) }) phoneSource: RewardPhoneSource;
  @Prop({ default: false }) phoneVerified: boolean;

  @Prop({ type: Types.ObjectId, ref: 'ZaloOaRewardSession', required: true }) sessionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true }) orderId: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(GrantStatus) }) status: GrantStatus;
  /** true when the promotion was assignedToAll, so no per-user assignment was needed. */
  @Prop({ default: false }) viaAssignedToAll: boolean;
  @Prop() assignedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZaloOaRewardGrantSchema = SchemaFactory.createForClass(ZaloOaRewardGrant);
ZaloOaRewardGrantSchema.index({ promotionId: 1, oaId: 1, oaUid: 1 }, { unique: true });
ZaloOaRewardGrantSchema.index({ promotionId: 1, userId: 1 }, { unique: true });
