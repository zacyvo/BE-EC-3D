import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ContractDocument = Contract & Document;

export enum ContractStatus {
  NEW     = 'NEW',      // Mới tạo — chờ khách điền thông tin
  REVIEW  = 'REVIEW',   // Khách đã submit — admin đang review
  DRAFT   = 'DRAFT',    // Bản nháp — khách xem lại qua link cũ
  FINAL   = 'FINAL',    // Bản chính thức — khoá chỉnh sửa
  SUCCESS = 'SUCCESS',  // Hoàn tất — đã ghi nhận tài chính
  CLOSED  = 'CLOSED',   // Đã hủy hợp đồng
}

@Schema({ _id: false })
export class ContractItem {
  @Prop({ required: true }) productId: string;
  @Prop({ required: true, trim: true }) productCode: string; // last 6 chars of _id
  @Prop({ required: true, trim: true }) productName: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true, min: 0 }) unitPrice: number;
  @Prop({ required: true, min: 0 }) subtotal: number;
  /** Giá vốn tại thời điểm tạo — dùng khi ghi nhận tài chính, không trả về phía user */
  @Prop({ required: true, min: 0, default: 0 }) costPrice: number;
}

export const ContractItemSchema = SchemaFactory.createForClass(ContractItem);

@Schema({ _id: false })
export class ContractParty {
  @Prop({ trim: true, default: '' }) name: string;
  @Prop({ trim: true, default: '' }) address: string;
  @Prop({ trim: true, default: '' }) representative: string;
  @Prop({ trim: true, default: '' }) position: string;
  @Prop({ trim: true, default: '' }) phone: string;
  @Prop({ trim: true, default: '' }) email: string;
  /** Mã số thuế / CCCD */
  @Prop({ trim: true, default: '' }) taxCode: string;
}

export const ContractPartySchema = SchemaFactory.createForClass(ContractParty);

@Schema({ _id: false })
export class ContractStatusHistory {
  @Prop({ required: true }) from: string;
  @Prop({ required: true }) to: string;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true, enum: ['staff', 'user'] }) byType: string;
  @Prop({ default: '' }) byId: string;
  @Prop({ trim: true, default: '' }) note: string;
}

export const ContractStatusHistorySchema = SchemaFactory.createForClass(ContractStatusHistory);

@Schema({ timestamps: true })
export class Contract {
  _id: Types.ObjectId;

  /** Số hợp đồng, VD: 0001/HĐ-2026 */
  @Prop({ required: true, unique: true, trim: true })
  contractNo: string;

  @Prop({ default: ContractStatus.NEW, enum: Object.values(ContractStatus) })
  status: ContractStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** SĐT đăng nhập của người yêu cầu (đã chuẩn hoá 0xxxxxxxxx) */
  @Prop({ required: true, trim: true })
  userPhone: string;

  /** Token trên URL công khai gửi cho khách */
  @Prop({ required: true, unique: true })
  accessToken: string;

  /** Mã bảo mật 8 ký tự — chỉ xem được qua endpoint reveal (yêu cầu mật khẩu admin) */
  @Prop({ required: true, select: false })
  securityCode: string;

  @Prop({ type: [ContractItemSchema], required: true, default: [] })
  items: ContractItem[];

  @Prop({ required: true, min: 0, default: 0 })
  totalAmount: number;

  /** Bên A — bên đặt hàng (khách điền) */
  @Prop({ type: ContractPartySchema, default: () => ({}) })
  partyA: ContractParty;

  /** Bên B — bên thiết kế và sản xuất */
  @Prop({ type: ContractPartySchema, default: () => ({}) })
  partyB: ContractParty;

  @Prop({ trim: true, default: 'TP. Hồ Chí Minh' }) signPlace: string;
  @Prop() signDate?: Date;

  /** Điều 1.2 — yêu cầu kỹ thuật khác */
  @Prop({ trim: true, default: '' }) technicalRequirements: string;

  /** Điều 3.3 — thông tin thanh toán (cố định theo cửa hàng, set khi tạo) */
  @Prop({ trim: true, default: '' }) bankAccountNumber: string;
  @Prop({ trim: true, default: '' }) bankName: string;
  @Prop({ trim: true, default: '' }) bankAccountHolder: string;

  /** Điều 4.1 — ngày giao hàng */
  @Prop() deliveryDate?: Date;

  /** Điều 4.2 — địa điểm giao hàng (khách điền) */
  @Prop({ trim: true, default: '' }) deliveryAddress: string;

  /** Ghi chú của khách khi submit */
  @Prop({ trim: true, default: '' }) userNote: string;

  /** Ghi chú nội bộ của admin — không trả về phía user */
  @Prop({ trim: true, default: '' }) adminNote: string;

  @Prop({ trim: true, default: '' }) closeReason: string;

  @Prop() submittedAt?: Date;
  @Prop() finalizedAt?: Date;
  @Prop() successAt?: Date;
  @Prop() closedAt?: Date;

  /** Bản ghi doanh thu tự tạo khi chuyển SUCCESS */
  @Prop({ type: Types.ObjectId, ref: 'ExternalRevenue' })
  revenueEntryId?: Types.ObjectId;

  /** Chống dò mã bảo mật */
  @Prop({ default: 0 }) unlockAttempts: number;
  @Prop() lockedUntil?: Date;

  @Prop({ type: [ContractStatusHistorySchema], default: [] })
  statusHistory: ContractStatusHistory[];

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt?: Date;
  @Prop() deletedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ContractSchema = SchemaFactory.createForClass(Contract);

ContractSchema.index({ status: 1, createdAt: -1 });
ContractSchema.index({ userPhone: 1 });
ContractSchema.index({ isDeleted: 1 });

ContractSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});
