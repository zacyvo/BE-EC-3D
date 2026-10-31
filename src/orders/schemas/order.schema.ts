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

/** Lifecycle of a return/refund request (Shopee-style "Trả hàng/Hoàn tiền"):
 *  REQUESTED → APPROVED → SHIPPING_BACK → RECEIVED → (REFUNDING →) COMPLETED
 *  with REJECTED (by the shop — at request time or after inspection) and CANCELLED
 *  (withdrawn by the customer before the parcel is on its way) as the other ends.
 *  Order.status stays DELIVERED throughout; see src/order-returns. */
export enum ReturnStatus {
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  SHIPPING_BACK = 'SHIPPING_BACK',
  RECEIVED = 'RECEIVED',
  REFUNDING = 'REFUNDING',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

/** Return statuses in which the goods are back with the shop and the refund is decided —
 * revenue/sold-quantity computations subtract the returned part of these orders. */
export const RETURN_SETTLED_STATUSES = [ReturnStatus.REFUNDING, ReturnStatus.COMPLETED];

export enum ReturnReason {
  DAMAGED = 'DAMAGED',
  DEFECTIVE = 'DEFECTIVE',
  WRONG_ITEM = 'WRONG_ITEM',
  MISSING_PARTS = 'MISSING_PARTS',
  NOT_AS_DESCRIBED = 'NOT_AS_DESCRIBED',
  CHANGED_MIND = 'CHANGED_MIND',
}

/** One returned line — `itemIndex` points into Order.items (items have no _id); name/price
 * are snapshotted so the request reads correctly on its own. */
@Schema({ _id: false })
export class ReturnItem {
  @Prop({ required: true, min: 0 }) itemIndex: number;
  @Prop({ required: true }) productName: string;
  @Prop() productImage?: string;
  @Prop() color?: string;
  @Prop() size?: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true, min: 0 }) unitPrice: number;
}

const ReturnItemSchema = SchemaFactory.createForClass(ReturnItem);

/** Where the shop transfers the refund (storefront checkout is COD-only, so there is no
 * original online payment to reverse). */
@Schema({ _id: false })
export class RefundAccount {
  @Prop({ required: true }) bankName: string;
  @Prop({ required: true }) accountNumber: string;
  @Prop({ required: true }) accountHolder: string;
}

const RefundAccountSchema = SchemaFactory.createForClass(RefundAccount);

@Schema({ _id: false })
export class ReturnShipment {
  @Prop() carrierName?: string;
  @Prop({ required: true }) trackingCode: string;
  @Prop({ required: true }) shippedAt: Date;
}

const ReturnShipmentSchema = SchemaFactory.createForClass(ReturnShipment);

@Schema({ _id: false })
export class ReturnHistoryEntry {
  @Prop({ required: true, enum: Object.values(ReturnStatus) }) status: ReturnStatus;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true, enum: ['user', 'staff'] }) byType: 'user' | 'staff';
  @Prop() by?: string;
  @Prop() note?: string;
}

const ReturnHistoryEntrySchema = SchemaFactory.createForClass(ReturnHistoryEntry);

/** A customer's return/refund request — one per order (a withdrawn request can't be re-sent). */
@Schema({ _id: false })
export class OrderReturnRequest {
  @Prop({ required: true, enum: Object.values(ReturnStatus) }) status: ReturnStatus;
  @Prop({ type: [ReturnItemSchema], required: true }) items: ReturnItem[];
  @Prop({ required: true, enum: Object.values(ReturnReason) }) reason: ReturnReason;
  @Prop({ required: true }) description: string;
  @Prop({ type: [String], default: [] }) images: string[];
  @Prop({ type: RefundAccountSchema }) refundAccount?: RefundAccount;
  @Prop({ required: true }) requestedAt: Date;
  /** Account name at request time — what the owner's Zalo notification shows. */
  @Prop() requestedByName?: string;
  /** Suggested refund for the returned goods at request time (prorated discount, capped by paidAmount). */
  @Prop({ required: true, min: 0 }) estimatedRefund: number;
  /** Shop's note to the customer when approving (e.g. return instructions). */
  @Prop() shopNote?: string;
  @Prop() rejectReason?: string;
  @Prop({ enum: ['REQUEST', 'INSPECTION'] }) rejectedAt?: 'REQUEST' | 'INSPECTION';
  @Prop({ type: ReturnShipmentSchema }) shipment?: ReturnShipment;
  @Prop() receivedAt?: Date;
  @Prop() inspectionNote?: string;
  /** Refund for the goods, decided after inspection. */
  @Prop({ min: 0 }) refundAmount?: number;
  /** Return shipping cost reimbursed to the customer (shop-fault returns). */
  @Prop({ min: 0 }) returnShippingRefund?: number;
  @Prop() refundedAt?: Date;
  /** Bank transfer reference of the refund. */
  @Prop() refundTransferRef?: string;
  @Prop({ type: [ReturnHistoryEntrySchema], default: [] }) history: ReturnHistoryEntry[];
}

const OrderReturnRequestSchema = SchemaFactory.createForClass(OrderReturnRequest);

/** Lifecycle of a customer's request for a VAT e-invoice (hoá đơn điện tử):
 *  PENDING (VAT already added to the total) → APPROVED → ISSUED (invoice emailed),
 *  or PENDING → REJECTED (VAT removed from the total again). See orders/einvoice-request.util.ts. */
export enum EInvoiceRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  ISSUED = 'ISSUED',
}

export enum EInvoiceBuyerType {
  INDIVIDUAL = 'INDIVIDUAL',
  COMPANY = 'COMPANY',
}

/** Buyer details the customer gave for the invoice, plus the shop's decision. One per order —
 * a rejected request can't be re-sent (the shop can still fix details when issuing). */
@Schema({ _id: false })
export class OrderEInvoiceRequest {
  @Prop({ required: true, enum: Object.values(EInvoiceRequestStatus) }) status: EInvoiceRequestStatus;
  @Prop({ required: true, enum: Object.values(EInvoiceBuyerType) }) buyerType: EInvoiceBuyerType;
  /** Người mua hàng — the person's full name (also the invoice customer name for INDIVIDUAL). */
  @Prop({ required: true, trim: true }) buyerName: string;
  /** Tên đơn vị — required for COMPANY. */
  @Prop({ trim: true }) companyName?: string;
  /** Mã số thuế — required for COMPANY, optional (MST/CCCD) for INDIVIDUAL. */
  @Prop({ trim: true }) taxCode?: string;
  @Prop({ required: true, trim: true }) address: string;
  /** Where the issued invoice is sent. */
  @Prop({ required: true, trim: true, lowercase: true }) email: string;
  @Prop({ trim: true }) phone?: string;
  @Prop({ required: true, min: 0 }) vatRate: number;
  /** VAT added to Order.total by this request — mirrors Order.vatAmount while not REJECTED. */
  @Prop({ required: true, min: 0 }) vatAmount: number;
  @Prop({ required: true }) requestedAt: Date;
  /** Account name at request time — what the owner's Zalo notification shows. */
  @Prop() requestedByName?: string;
  @Prop() decidedAt?: Date;
  @Prop() decidedBy?: string;
  @Prop() rejectReason?: string;
  @Prop({ type: Types.ObjectId, ref: 'EInvoice' }) einvoiceId?: Types.ObjectId;
  @Prop() issuedAt?: Date;
  /** Public invoice page (opened with the key sent in the email). */
  @Prop() invoiceUrl?: string;
  @Prop() emailSentAt?: Date;
  /** Last email failure — cleared by a successful (re)send. */
  @Prop() emailError?: string;
}

const OrderEInvoiceRequestSchema = SchemaFactory.createForClass(OrderEInvoiceRequest);

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

  /** VAT added on top because the customer asked for a VAT e-invoice (0 otherwise). */
  @Prop({ default: 0, min: 0 }) vatAmount: number;

  /** Final payable amount = subtotal - discountAmount + shippingFee + vatAmount */
  @Prop({ required: true, min: 0 }) total: number;

  @Prop({ default: OrderStatus.PENDING, enum: Object.values(OrderStatus) })
  status: OrderStatus;

  @Prop() customerNote?: string;
  @Prop() csNote?: string;
  @Prop() cancelReason?: string;
  @Prop({ type: OrderCancelRequestSchema }) cancelRequest?: OrderCancelRequest;
  @Prop({ type: OrderCustomerCancelSchema }) customerCancel?: OrderCustomerCancel;
  /** First time the order reached DELIVERED — starts the return window. */
  @Prop() deliveredAt?: Date;
  @Prop({ type: OrderReturnRequestSchema }) returnRequest?: OrderReturnRequest;
  @Prop({ type: OrderEInvoiceRequestSchema }) einvoiceRequest?: OrderEInvoiceRequest;
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
   * 'ORDER_CREATED' / 'ORDER_CANCEL_REQUESTED' / 'ORDER_CANCELLED_BY_CUSTOMER' /
   * 'ORDER_RETURN_REQUESTED' / 'EINVOICE_REQUESTED' (owner Zalo Bot, the cancel/return/e-invoice
   * events are added by the same write that records them), 'ORDER_CREATED:ZALO_ZBS'
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
// Sparse: only orders with a return request carry the field (admin "Trả hàng" list).
OrderSchema.index({ 'returnRequest.status': 1, 'returnRequest.requestedAt': -1 }, { sparse: true });
// Sparse: only orders with an e-invoice request carry the field (admin "Yêu cầu HĐĐT" filter).
OrderSchema.index({ 'einvoiceRequest.status': 1 }, { sparse: true });
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
