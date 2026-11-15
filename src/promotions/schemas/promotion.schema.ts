import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PromotionDocument = Promotion & Document;

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
  /** Waives the shipping fee (fully, or up to maxDiscountAmount). `value` is unused (stored as 0). */
  FREE_SHIPPING = 'free_shipping',
}

/** Built-in free-shipping code seeded on boot (see PromotionsService.ensureDefaultFreeShipCoupon). */
export const DEFAULT_FREE_SHIP_CODE = 'FREE_SHIP';
export const DEFAULT_FREE_SHIP_SYSTEM_KEY = 'DEFAULT_FREE_SHIP';

/** Per-user usage tracking embedded inside a CouponItem */
@Schema({ _id: false })
export class UsageRecord {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;
  @Prop({ default: 0 }) count: number;
}
export const UsageRecordSchema = SchemaFactory.createForClass(UsageRecord);

/**
 * A single coupon code embedded inside a Promotion program.
 * Each CouponItem has its own discount config and usage tracking.
 */
@Schema({ _id: true })
export class CouponItem {
  _id: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true }) code: string;

  @Prop({ required: true, enum: Object.values(DiscountType) })
  type: DiscountType;

  /** percentage 0–100 or fixed VND (0 for free_shipping) */
  @Prop({ required: true, min: 0 }) value: number;

  /** Minimum order total (VND). 0 = no minimum */
  @Prop({ default: 0, min: 0 }) minOrderValue: number;

  /** percentage / free_shipping: cap max discount (VND). 0 = no cap (free_shipping: whole fee) */
  @Prop({ default: 0, min: 0 }) maxDiscountAmount: number;

  /** 0 = unlimited total uses */
  @Prop({ default: 0, min: 0 }) totalUsageLimit: number;

  /** Max times one user can use this code */
  @Prop({ default: 1, min: 1 }) perUserUsageLimit: number;

  /** Accumulated usage across all users */
  @Prop({ default: 0, min: 0 }) totalUsedCount: number;

  /** Per-user usage records (hidden from user-facing APIs) */
  @Prop({ type: [UsageRecordSchema], default: [] })
  usageRecords: UsageRecord[];
}
export const CouponItemSchema = SchemaFactory.createForClass(CouponItem);

/**
 * Promotion Program — contains one or more coupon codes.
 * Access control (assignedToAll / assignedUsers), date range,
 * and active status are managed at the program level.
 */
@Schema({ timestamps: true })
export class Promotion {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true }) name: string;
  @Prop({ trim: true }) description?: string;

  @Prop({ required: true }) startDate: Date;
  @Prop({ required: true }) endDate: Date;

  @Prop({ default: true }) isActive: boolean;

  /** All authenticated users can use coupons in this program */
  @Prop({ default: false }) assignedToAll: boolean;

  /** Specific users who can use this program's coupons */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  assignedUsers: Types.ObjectId[];

  /** Coupon codes belonging to this program */
  @Prop({ type: [CouponItemSchema], default: [] })
  coupons: CouponItem[];

  @Prop({ type: Types.ObjectId, ref: 'Staff' }) createdBy?: Types.ObjectId;

  /** Set only on programs the system seeds itself (e.g. the default FREE_SHIP program), so the
   * seed runs once per database and never duplicates. */
  @Prop() systemKey?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const PromotionSchema = SchemaFactory.createForClass(Promotion);
PromotionSchema.index({ isActive: 1, startDate: 1, endDate: 1 });
PromotionSchema.index({ assignedUsers: 1 });
PromotionSchema.index({ 'coupons.code': 1 });
PromotionSchema.index({ systemKey: 1 }, { unique: true, sparse: true });
