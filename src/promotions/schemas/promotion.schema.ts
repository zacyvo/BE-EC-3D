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

  /** percentage / fixed: ALSO waive the shipping fee ("giảm giá kèm free ship") — counts as the
   * order's one shipping coupon. Ignored for free_shipping (it already does that). */
  @Prop({ default: false }) includeFreeShipping: boolean;

  /** Cap of the bundled free shipping (VND). 0 = the whole fee. */
  @Prop({ default: 0, min: 0 }) freeShippingMaxAmount: number;

  /** Accumulated usage across all users */
  @Prop({ default: 0, min: 0 }) totalUsedCount: number;

  /** Per-user usage records (hidden from user-facing APIs) */
  @Prop({ type: [UsageRecordSchema], default: [] })
  usageRecords: UsageRecord[];
}
export const CouponItemSchema = SchemaFactory.createForClass(CouponItem);

/** Delivery region of the order (matches the flat shipping-fee zones). */
export enum PromotionRegion {
  HCM = 'HCM',
  OUTSIDE_HCM = 'OUTSIDE_HCM',
}

/** Payment methods a program can be restricted to (same values as orders' PaymentMethod). */
export const PROMOTION_PAYMENT_METHODS = ['COD', 'BANK_TRANSFER'] as const;
export type PromotionPaymentMethod = (typeof PROMOTION_PAYMENT_METHODS)[number];

/**
 * Who / what / when a program's codes apply to. Every field is optional and off when unset
 * (0, false, empty) — the set ones must ALL hold (AND). Checked by PromotionsService at
 * validate time and again when the order is placed.
 *  - "Đơn thành công" = an order of this customer in status DELIVERED (not deleted); "tổng chi tiêu"
 *    = their totals minus refunds of settled returns.
 *  - Days/hours are Vietnam time (UTC+7).
 */
@Schema({ _id: false })
export class PromotionConditions {
  // ── Khách hàng ──
  /** Account created within the last N days ("Lần đầu đăng ký tài khoản"). */
  @Prop({ min: 0 }) newAccountWithinDays?: number;
  /** Customer has no previous order (cancelled ones don't count). */
  @Prop() firstOrderOnly?: boolean;
  @Prop({ min: 0 }) minCompletedOrders?: number;
  /** Upper bound on completed orders (e.g. "khách mới mua 1–2 lần"). */
  @Prop({ min: 0 }) maxCompletedOrders?: number;
  /** Sum of the customer's completed orders (VND). */
  @Prop({ min: 0 }) minTotalSpent?: number;
  /** Only during the customer's birthday month (profile `dob`). */
  @Prop() birthdayMonthOnly?: boolean;
  /** Win-back: has bought before, but no order in the last N days. */
  @Prop({ min: 0 }) inactiveDays?: number;
  /** Customer opted in to promotional messages. */
  @Prop() marketingOptInOnly?: boolean;

  // ── Đơn hàng ──
  /** Total quantity of items in the order. */
  @Prop({ min: 0 }) minItemQuantity?: number;
  /** Discount scope: only these products / categories (either list matching is enough). The
   * discount is computed on the eligible items' subtotal; the order needs ≥ 1 such item. */
  @Prop({ type: [Types.ObjectId], ref: 'Product', default: undefined }) productIds?: Types.ObjectId[];
  @Prop({ type: [Types.ObjectId], ref: 'Category', default: undefined }) categoryIds?: Types.ObjectId[];
  @Prop({ enum: Object.values(PromotionRegion) }) region?: PromotionRegion;
  @Prop({ type: [String], enum: PROMOTION_PAYMENT_METHODS, default: undefined })
  paymentMethods?: PromotionPaymentMethod[];

  // ── Thời gian ──
  /** Days of week the codes work: 0 = Chủ nhật … 6 = Thứ 7. */
  @Prop({ type: [Number], default: undefined }) weekdays?: number[];
  /** Daily time window [hourFrom, hourTo) — both set and different to take effect; wraps midnight
   * when hourFrom > hourTo (e.g. 22 → 2). */
  @Prop({ min: 0, max: 24 }) hourFrom?: number;
  @Prop({ min: 0, max: 24 }) hourTo?: number;
}
export const PromotionConditionsSchema = SchemaFactory.createForClass(PromotionConditions);

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

  /** Extra eligibility rules for every code of this program (see PromotionConditions). */
  @Prop({ type: PromotionConditionsSchema, default: {} })
  conditions: PromotionConditions;

  /** Codes of this program can't be combined with any other code in the same order. */
  @Prop({ default: false }) exclusive: boolean;

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
