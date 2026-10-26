import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZbsCampaignMessageDocument = ZbsCampaignMessage & Document;

export enum ZbsCampaignMessageStatus {
  /** Part of a DRAFT campaign — nothing will be sent until it is confirmed. */
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY_PENDING = 'RETRY_PENDING',
  /** Zalo answered error 0 (paid). */
  ACCEPTED = 'ACCEPTED',
  /** Only from the message-status API, never inferred. */
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  /** Zalo may or may not have sent it — never resent automatically. */
  UNKNOWN = 'UNKNOWN',
  SKIPPED_INVALID_RECIPIENT = 'SKIPPED_INVALID_RECIPIENT',
  SKIPPED_INELIGIBLE = 'SKIPPED_INELIGIBLE',
  /** Promotion ended/deactivated or the coupon was exhausted/removed before this send. */
  SKIPPED_COUPON_UNAVAILABLE = 'SKIPPED_COUPON_UNAVAILABLE',
  CANCELLED = 'CANCELLED',
}

@Schema({ _id: false })
export class ZbsCampaignAttempt {
  @Prop({ required: true }) at: Date;
  @Prop({ required: true }) outcome: string;
  @Prop() errorCode?: string;
  @Prop() httpStatus?: number;
  @Prop() durationMs?: number;
}
const ZbsCampaignAttemptSchema = SchemaFactory.createForClass(ZbsCampaignAttempt);

/**
 * One row = one promotion message to one phone. Separate from notification_jobs (which is
 * order-bound and whose ZBS worker would otherwise pick these up).
 *
 * `dedupKey` = PROMO:<couponId>:<phone> with a unique index: the same coupon is never sent
 * twice to the same phone, across all campaigns. A row that was never sent (cancelled)
 * releases its key so a later campaign may include that phone again.
 * The text is not stored — it is rebuilt from the live promotion/user at send time.
 */
@Schema({ timestamps: true, collection: 'zalo_zbs_campaign_messages' })
export class ZbsCampaignMessage {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ZbsCampaign', required: true }) campaignId: Types.ObjectId;
  @Prop({ required: true }) dedupKey: string;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;
  /** Normalized 84xxxxxxxxx. Only exposed masked via the API. */
  @Prop({ required: true }) phone: string;
  /** tracking_id sent to ZBS: "LGPR" + this row's id. */
  @Prop({ required: true }) trackingId: string;

  @Prop({ required: true, enum: Object.values(ZbsCampaignMessageStatus), default: ZbsCampaignMessageStatus.DRAFT })
  status: ZbsCampaignMessageStatus;
  @Prop({ default: 0 }) attemptCount: number;
  @Prop({ required: true }) maxAttempts: number;
  @Prop({ default: () => new Date() }) nextAttemptAt: Date;
  @Prop() lockedUntil?: Date;
  @Prop() lockOwner?: string;

  @Prop() providerMessageId?: string;
  @Prop() providerSentTime?: Date;
  @Prop({ type: Object }) providerQuota?: { dailyQuota?: number; remainingQuota?: number };
  @Prop() providerDeliveryStatus?: number;
  @Prop() deliveryCheckedAt?: Date;
  @Prop() deliveredAt?: Date;

  @Prop() errorClass?: string;
  @Prop() lastErrorCode?: string;
  @Prop() lastErrorMessage?: string;
  @Prop() lastHttpStatus?: number;
  @Prop({ type: [ZbsCampaignAttemptSchema], default: [] }) attempts: ZbsCampaignAttempt[];

  @Prop() acceptedAt?: Date;
  @Prop() processedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZbsCampaignMessageSchema = SchemaFactory.createForClass(ZbsCampaignMessage);
ZbsCampaignMessageSchema.index({ dedupKey: 1 }, { unique: true });
ZbsCampaignMessageSchema.index({ campaignId: 1, status: 1 });
// Worker claim: status ∈ {PENDING, RETRY_PENDING} AND nextAttemptAt <= now.
ZbsCampaignMessageSchema.index({ status: 1, nextAttemptAt: 1 });
// Daily cap / stats.
ZbsCampaignMessageSchema.index({ acceptedAt: -1 });
