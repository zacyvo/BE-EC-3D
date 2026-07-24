import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EInvoiceDocument = EInvoice & Document;

/** Trạng thái cục bộ tại hệ thống của chúng ta (khác với InvoiceStatus của EasyInvoice) */
export enum EInvoiceLocalStatus {
  ISSUED = 'ISSUED', // Đã tạo và phát hành thành công qua EasyInvoice
  CANCELLED = 'CANCELLED', // Đã hủy (EasyInvoice thay thế bằng hoá đơn 0 đồng theo NĐ70)
  FAILED = 'FAILED', // Gọi EasyInvoice thất bại
}

/** Mã trạng thái hoá đơn phía EasyInvoice — xem Phụ lục VII.2 tài liệu tích hợp */
export enum EasyInvoiceStatus {
  PENDING_SIGN = -1,
  UNSIGNED = 0,
  SIGNED = 1,
  TAX_DECLARED = 2,
  REPLACED = 3,
  ADJUSTED = 4,
  CANCELLED = 5,
  APPROVED = 6,
}

@Schema({ _id: false })
export class EInvoiceItem {
  @Prop({ trim: true }) code?: string;
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ trim: true, default: 'Cái' }) unit: string;
  @Prop({ required: true, min: 0 }) quantity: number;
  @Prop({ required: true, min: 0 }) unitPrice: number;
  /** Tỉ lệ chiết khấu (%) — chỉ mang tính hiển thị, xem VII.6 */
  @Prop({ min: 0, max: 100 }) discountPercent?: number;
  /** Tổng tiền chiết khấu (VND) — trừ vào Total trước khi tính thuế */
  @Prop({ min: 0, default: 0 }) discountAmount: number;
  /** Thuế suất: 0,5,8,10 | -1 KCT | -2 KKKN | -3 Khác (kèm vatRateOther) */
  @Prop({ required: true }) vatRate: number;
  @Prop() vatRateOther?: number;
  /** Loại sản phẩm — 1 Hàng hoá dịch vụ (mặc định), 2 Khuyến mại, 3 Chiết khấu, 4 Ghi chú, 5 Hàng hoá đặc trưng */
  @Prop({ default: 1, min: 1, max: 5 }) feature: number;
  /** Tổng tiền trước thuế (đã trừ chiết khấu) */
  @Prop({ required: true }) total: number;
  @Prop({ required: true, default: 0 }) vatAmount: number;
  @Prop({ required: true }) amount: number;
}

export const EInvoiceItemSchema = SchemaFactory.createForClass(EInvoiceItem);

@Schema({ timestamps: true })
export class EInvoice {
  _id: Types.ObjectId;

  // ─── EasyInvoice integration ──────────────────────────────────────────────
  /** Ikey — khoá tích hợp duy nhất gửi sang EasyInvoice để định danh hoá đơn */
  @Prop({ required: true, unique: true })
  ikey: string;

  @Prop({ trim: true, default: '' }) pattern: string;
  @Prop({ trim: true, default: '' }) serial: string;
  /** Số hoá đơn do EasyInvoice cấp sau khi phát hành */
  @Prop({ trim: true }) invoiceNo?: string;
  /** Mã tra cứu trên cổng EasyInvoice */
  @Prop({ trim: true }) lookupCode?: string;
  /** Link tra cứu hoá đơn trên hệ thống EasyInvoice */
  @Prop({ trim: true }) linkView?: string;
  /** Mã trạng thái hoá đơn phía EasyInvoice (xem EasyInvoiceStatus) */
  @Prop() easyInvoiceStatus?: number;
  @Prop({ trim: true, default: '' }) tctCheckStatus?: string;
  @Prop({ trim: true, default: '' }) tctErrorMessage?: string;

  @Prop({ default: EInvoiceLocalStatus.ISSUED, enum: Object.values(EInvoiceLocalStatus) })
  localStatus: EInvoiceLocalStatus;

  @Prop({ trim: true, default: '' }) errorMessage: string;

  // ─── Liên kết nghiệp vụ (tuỳ chọn) ────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contract' })
  contractId?: Types.ObjectId;

  // ─── Snapshot người mua (Buyer/CusXXX trong XmlData) ──────────────────────
  @Prop({ required: true, trim: true }) buyerName: string;
  @Prop({ required: true, trim: true }) customerName: string;
  @Prop({ trim: true, default: '' }) customerTaxCode: string;
  @Prop({ trim: true, default: '' }) customerAddress: string;
  @Prop({ trim: true, default: '' }) customerPhone: string;
  @Prop({ trim: true, default: '' }) customerEmail: string;

  // ─── Nội dung hoá đơn ──────────────────────────────────────────────────────
  @Prop({ type: [EInvoiceItemSchema], required: true, default: [] })
  items: EInvoiceItem[];

  @Prop({ required: true, min: 0 }) totalBeforeTax: number;
  @Prop({ required: true, min: 0, default: 0 }) vatAmount: number;
  @Prop({ required: true, min: 0 }) totalAmount: number;
  @Prop({ trim: true, default: 'Tiền mặt/Chuyển khoản' }) paymentMethod: string;
  @Prop({ trim: true, default: 'VND' }) currencyUnit: string;
  @Prop({ required: true }) arisingDate: Date;
  @Prop() issueDate?: Date;
  @Prop({ trim: true, default: '' }) note: string;

  // ─── Kiểm soát truy cập phía frontend-user ("key mở hoá đơn") ─────────────
  /** Token trên URL công khai gửi cho khách */
  @Prop({ required: true, unique: true })
  accessToken: string;

  /** Key mở hoá đơn — nếu liên kết hợp đồng thì DÙNG CHUNG mã bảo mật của hợp đồng đó,
   * nếu không liên kết thì sinh khoá riêng cho hoá đơn. Chỉ xem được qua endpoint reveal-key. */
  @Prop({ required: true, select: false })
  securityCode: string;

  /** true nếu securityCode được sao chép từ hợp đồng liên kết (dùng chung khoá) */
  @Prop({ default: false })
  sharedKeyFromContract: boolean;

  /** Chống dò khoá (bruteforce) — giống cơ chế của Contract */
  @Prop({ default: 0 }) unlockAttempts: number;
  @Prop() lockedUntil?: Date;

  @Prop({ trim: true, default: '' }) cancelReason: string;
  @Prop() cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const EInvoiceSchema = SchemaFactory.createForClass(EInvoice);

EInvoiceSchema.index({ localStatus: 1, createdAt: -1 });
EInvoiceSchema.index({ orderId: 1 });
EInvoiceSchema.index({ contractId: 1 });
EInvoiceSchema.index({ isDeleted: 1 });

EInvoiceSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});
