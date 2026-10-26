import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZbsCampaignDocument = ZbsCampaign & Document;

/**
 * DRAFT → (SUPER_ADMIN confirms the exact recipient count) → SENDING → COMPLETED.
 * SENDING ⇄ PAUSED (by an admin, or automatically on a config/auth/quota/template problem).
 * DRAFT / SENDING / PAUSED → CANCELLED (unsent messages are dropped, sent ones stay).
 */
export enum ZbsCampaignStatus {
  DRAFT = 'DRAFT',
  SENDING = 'SENDING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** Who receives the campaign. Always intersected with who may USE the coupon
 * (promotion.assignedToAll or promotion.assignedUsers). */
export enum ZbsCampaignAudience {
  /** Users listed in promotion.assignedUsers. */
  ASSIGNED_USERS = 'ASSIGNED_USERS',
  /** Storefront customers with at least one DELIVERED order. */
  DELIVERED_CUSTOMERS = 'DELIVERED_CUSTOMERS',
  /** Storefront customers with at least one non-cancelled order. */
  ORDERED_CUSTOMERS = 'ORDERED_CUSTOMERS',
}

/** Why candidates were left out when the draft was built (shown in the preview). */
@Schema({ _id: false })
export class ZbsCampaignExclusions {
  @Prop({ default: 0 }) noPhone: number;
  @Prop({ default: 0 }) invalidPhone: number;
  @Prop({ default: 0 }) duplicatePhone: number;
  @Prop({ default: 0 }) blockedOrDeleted: number;
  @Prop({ default: 0 }) notAllowedByPromotion: number;
  @Prop({ default: 0 }) couponAlreadyUsed: number;
  @Prop({ default: 0 }) alreadyReceived: number;
}
const ZbsCampaignExclusionsSchema = SchemaFactory.createForClass(ZbsCampaignExclusions);

@Schema({ timestamps: true, collection: 'zalo_zbs_campaigns' })
export class ZbsCampaign {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true }) name: string;
  @Prop({ type: Types.ObjectId, ref: 'Promotion', required: true }) promotionId: Types.ObjectId;
  /** CouponItem._id inside the promotion. */
  @Prop({ type: Types.ObjectId, required: true }) couponId: Types.ObjectId;
  /** Snapshots for a readable history even if the promotion is edited later. The message
   * content itself is rebuilt from the live promotion at send time. */
  @Prop({ required: true }) couponCode: string;
  @Prop({ required: true }) promotionName: string;

  @Prop({ required: true, enum: Object.values(ZbsCampaignAudience) }) audience: ZbsCampaignAudience;
  @Prop({ required: true }) templateId: string;

  @Prop({ required: true, enum: Object.values(ZbsCampaignStatus), default: ZbsCampaignStatus.DRAFT })
  status: ZbsCampaignStatus;
  /** Set while PAUSED: MANUAL or the error code that stopped sending. */
  @Prop() pauseCode?: string;
  @Prop() pauseReason?: string;

  @Prop({ required: true, default: 0 }) recipientCount: number;
  @Prop({ type: ZbsCampaignExclusionsSchema, default: () => ({}) }) exclusions: ZbsCampaignExclusions;
  /** Preview warnings at draft time (e.g. coupon capacity below recipient count). */
  @Prop({ type: [String], default: [] }) warnings: string[];
  /** Unit price at draft time (ENV or template info) — for the cost ESTIMATE only. */
  @Prop() unitPriceVnd?: number;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true }) createdBy: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Staff' }) confirmedBy?: Types.ObjectId;
  @Prop() confirmedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'Staff' }) cancelledBy?: Types.ObjectId;
  @Prop() cancelledAt?: Date;
  @Prop() completedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZbsCampaignSchema = SchemaFactory.createForClass(ZbsCampaign);
ZbsCampaignSchema.index({ createdAt: -1 });
// "One open campaign per coupon" lookup + the worker's list of SENDING campaigns.
ZbsCampaignSchema.index({ couponId: 1, status: 1 });
ZbsCampaignSchema.index({ status: 1 });
