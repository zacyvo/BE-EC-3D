import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  PROCESSING = 'PROCESSING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

/** Statuses that count as an actual (non-cancelled, non-pending) sale — used
 * wherever revenue/sold-quantity is computed from order data. */
export const SOLD_ORDER_STATUSES = [
  OrderStatus.DELIVERED,
  OrderStatus.CONFIRMED,
  OrderStatus.SHIPPED,
  OrderStatus.PROCESSING,
];

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true }) productId: Types.ObjectId;
  @Prop({ required: true }) productName: string;
  @Prop({ required: true }) productImage: string;
  @Prop({ required: true }) productSlug: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true }) unitPrice: number;
  @Prop({ required: true }) subtotal: number;
  @Prop() note?: string;
  /** Selected color/size variant, if the product had variant options at purchase time. */
  @Prop() color?: string;
  @Prop() size?: string;
}

const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OldAddress {
  @Prop() ward?: string;
  @Prop({ required: true }) district: string;
  @Prop({ required: true }) province: string;
  @Prop() wardCode?: number;
  @Prop({ required: true }) districtCode: number;
}

const OldAddressSchema = SchemaFactory.createForClass(OldAddress);

@Schema({ _id: false })
export class ShippingInfo {
  @Prop({ required: true }) recipientName: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true }) street: string;
  @Prop({ required: true }) ward: string;
  @Prop({ default: '' }) district: string;
  @Prop({ required: true }) city: string;
  @Prop() note?: string;
  /** Pre-merger (2025) address this was entered/converted from, if any. Absent = new address entered directly. */
  @Prop({ type: OldAddressSchema }) oldAddress?: OldAddress;
}

const ShippingInfoSchema = SchemaFactory.createForClass(ShippingInfo);

@Schema({ _id: false })
export class Delivery {
  @Prop() carrierName?: string;
  @Prop() trackingCode?: string;
  @Prop() trackingUrl?: string;
  @Prop() estimatedDeliveryDate?: Date;
  /** Declared parcel value handed to the carrier (SPX "Giá trị bưu gửi") — kept
   * separate from `order.total` since it's a point-in-time declaration to the
   * carrier, not a live derived value. */
  @Prop({ min: 0 }) insuranceAmount?: number;
  /** Cash-on-delivery amount handed to the carrier (SPX "Số tiền COD") — may
   * differ from `order.total` when part of the order was already paid. */
  @Prop({ min: 0 }) codAmount?: number;
}

const DeliverySchema = SchemaFactory.createForClass(Delivery);

@Schema({ _id: false })
export class AppliedCoupon {
  @Prop({ required: true }) code: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true, min: 0 }) discountAmount: number;
}

const AppliedCouponSchema = SchemaFactory.createForClass(AppliedCoupon);

@Schema({ _id: false })
export class AdminDirectDiscount {
  @Prop({ required: true, enum: ['AMOUNT', 'PERCENT'] }) type: 'AMOUNT' | 'PERCENT';
  @Prop({ required: true, min: 0 }) value: number;
  @Prop() reason?: string;
  /** Computed discount in VND */
  @Prop({ required: true, min: 0 }) amount: number;
}

const AdminDirectDiscountSchema = SchemaFactory.createForClass(AdminDirectDiscount);

/** Identifies the order on the marketplace it was imported from (e.g. Shopee's own
 * "Mã đơn hàng"), so a re-uploaded export updates the same Order instead of duplicating it. */
@Schema({ _id: false })
export class OrderExternalRef {
  @Prop({ required: true }) channel: string;
  @Prop({ required: true }) code: string;
  @Prop() packageCode?: string;
}

const OrderExternalRefSchema = SchemaFactory.createForClass(OrderExternalRef);

/** Statuses in which the customer may cancel the order themselves (owner is notified). */
export const USER_CANCELLABLE_STATUSES = [OrderStatus.PENDING];
/** Statuses in which the customer can only ASK the shop to cancel (owner is notified).
 * Every other status (CONFIRMED, SHIPPED, ...) can't be cancelled by the customer at all. */
export const USER_CANCEL_REQUESTABLE_STATUSES = [OrderStatus.PROCESSING];

/** A customer's request to cancel an order they can no longer cancel themselves. One per
 * order — the shop resolves it by cancelling (or not) through the normal status update. */
@Schema({ _id: false })
export class OrderCancelRequest {
  @Prop({ required: true }) requestedAt: Date;
  @Prop() reason?: string;
  /** Account name at request time — what the owner's Zalo notification shows. */
  @Prop() requestedByName?: string;
}

const OrderCancelRequestSchema = SchemaFactory.createForClass(OrderCancelRequest);

/** Set when the customer cancelled the order themselves (the reason is in `cancelReason`). */
@Schema({ _id: false })
export class OrderCustomerCancel {
  @Prop({ required: true }) cancelledAt: Date;
  /** Account name at cancel time — what the owner's Zalo notification shows. */
  @Prop() cancelledByName?: string;
}

const OrderCustomerCancelSchema = SchemaFactory.createForClass(OrderCustomerCancel);

@Schema({ timestamps: true })
export class Order {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;
  @Prop({ type: [OrderItemSchema], required: true }) items: OrderItem[];
  @Prop({ type: ShippingInfoSchema, required: true }) shippingInfo: ShippingInfo;

  /** Original total before discount */
  @Prop({ required: true, min: 0 }) subtotal: number;

  /** Total discount from all applied coupons */
  @Prop({ default: 0, min: 0 }) discountAmount: number;

  /** Applied coupon records */
  @Prop({ type: [AppliedCouponSchema], default: [] })
  appliedCoupons: AppliedCoupon[];

  /** Shipping fee added on top of product subtotal */
  @Prop({ default: 0, min: 0 }) shippingFee: number;

  /** Final payable amount = subtotal - discountAmount + shippingFee */
  @Prop({ required: true, min: 0 }) total: number;

  @Prop({ default: OrderStatus.PENDING, enum: Object.values(OrderStatus) })
  status: OrderStatus;

  @Prop() customerNote?: string;
  @Prop() csNote?: string;
  @Prop() cancelReason?: string;
  @Prop({ type: OrderCancelRequestSchema }) cancelRequest?: OrderCancelRequest;
  @Prop({ type: OrderCustomerCancelSchema }) customerCancel?: OrderCustomerCancel;
  @Prop() adminNote?: string;
  @Prop({ default: false }) createdByAdmin: boolean;
  @Prop() createdByStaffId?: string;

  /** Direct discount applied by admin (separate from coupon discounts) */
  @Prop({ type: AdminDirectDiscountSchema })
  adminDirectDiscount?: AdminDirectDiscount;

  @Prop({ type: DeliverySchema }) delivery?: Delivery;

  @Prop({ default: 0, min: 0 }) paidAmount: number;

  /** Set when this order was imported/synced from a marketplace (e.g. Shopee) instead
   * of placed directly on Luxe Glow. Absent = a normal order. */
  @Prop({ type: OrderExternalRefSchema }) externalRef?: OrderExternalRef;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt?: Date;
  @Prop() deletedBy?: string;

  @Prop({ default: 1 }) currentVersion: number;

  /** Transactional outbox for notifications (see zalo-bot/order-notification.service.ts):
   * written in the SAME insert as the order, so the intent exists iff the order does; the
   * worker of each channel pulls its own marker once the notification jobs exist —
   * 'ORDER_CREATED' / 'ORDER_CANCEL_REQUESTED' / 'ORDER_CANCELLED_BY_CUSTOMER' (owner Zalo Bot,
   * the cancel events are added by the same update that records them), 'ORDER_CREATED:ZALO_ZBS'
   * (customer ZBS). Absent on most
   * orders; hidden from API responses by the toJSON transform below. */
  @Prop({ type: [String], default: undefined }) pendingNotificationEvents?: string[];

  createdAt: Date;
  updatedAt: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ isDeleted: 1 });
// Sparse: only orders imported from a marketplace carry externalRef, so this never
// collides with plain orders (which omit the field entirely).
OrderSchema.index({ 'externalRef.channel': 1, 'externalRef.code': 1 }, { unique: true, sparse: true });
// Sparse: only orders with a not-yet-dispatched notification carry the field.
OrderSchema.index({ pendingNotificationEvents: 1 }, { sparse: true });
// Internal worker state — keep it out of checkout/admin API responses.
OrderSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.pendingNotificationEvents;
    return ret;
  },
});
OrderSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
  next();
});
