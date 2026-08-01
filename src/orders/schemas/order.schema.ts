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
OrderSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
  next();
});
