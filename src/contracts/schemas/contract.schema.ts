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

/** Điều 3.3 — bộ thông tin thanh toán admin chọn khi tạo/sửa hợp đồng */
export enum PaymentInfoType {
  COMPANY    = 'COMPANY',    // Công ty — HO KINH DOANH LUXE GLOW
  INDIVIDUAL = 'INDIVIDUAL', // Cá nhân — QUACH PHUONG THANH TRUC
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

@Schema({ _id: false })
export class PaymentInstallment {
  /** % giá trị hợp đồng của đợt này */
  @Prop({ required: true, min: 0, max: 100 }) percent: number;
  /** Mốc thanh toán, VD: "ngay khi ký hợp đồng" */
  @Prop({ required: true, trim: true }) timing: string;
}

export const PaymentInstallmentSchema = SchemaFactory.createForClass(PaymentInstallment);

// ── Ký số (PAdES) — xem backend/src/document-signing/ ───────────────────────

export enum SignatureMode {
  PKI = 'PKI', // chữ ký số thật (USB token), ký ngoài hệ thống rồi upload
  SIMPLE = 'SIMPLE', // chữ ký điện tử đơn giản (canvas) — không phải PKI thật
}

export enum PartySignatureStatus {
  PENDING = 'PENDING',
  UPLOADED = 'UPLOADED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

@Schema({ _id: false })
export class PartyBSignature {
  @Prop({ default: PartySignatureStatus.PENDING, enum: Object.values(PartySignatureStatus) })
  status: PartySignatureStatus;
  @Prop() signedPdfUrl?: string;
  @Prop() signedPdfPublicId?: string;
  @Prop({ trim: true, default: '' }) signerCertCN: string;
  @Prop({ trim: true, default: '' }) signerCertSerial: string;
  @Prop({ trim: true, default: '' }) signerCertIssuer: string;
  @Prop() certNotBefore?: Date;
  @Prop() certNotAfter?: Date;
  /** Thời điểm ký theo CMS signed attributes — không phải thời điểm upload */
  @Prop() signingTime?: Date;
  @Prop() uploadedAt?: Date;
  @Prop() verifiedAt?: Date;
  /** Luôn false ở MVP — chưa xác minh chuỗi CA gốc, xem document-signing/pades/pades.types.ts */
  @Prop({ default: false }) chainValidated: boolean;
  @Prop({ trim: true, default: '' }) rejectReason: string;
  @Prop({ trim: true, default: '' }) uploadedBy: string;
}

export const PartyBSignatureSchema = SchemaFactory.createForClass(PartyBSignature);

@Schema({ _id: false })
export class SimpleSignatureRecord {
  @Prop({ required: true }) canvasImageUrl: string;
  @Prop({ required: true, trim: true }) confirmedName: string;
  @Prop({ required: true }) ipAddress: string;
  @Prop({ required: true }) userAgent: string;
  @Prop({ required: true }) confirmedAt: Date;
  /** sha256(canvasImageUrl + confirmedName + contractId + confirmedAt) — chống sửa bản ghi này */
  @Prop({ required: true }) integrityHash: string;
}

export const SimpleSignatureRecordSchema = SchemaFactory.createForClass(SimpleSignatureRecord);

@Schema({ _id: false })
export class PartyASignature {
  @Prop({ default: PartySignatureStatus.PENDING, enum: Object.values(PartySignatureStatus) })
  status: PartySignatureStatus;
  @Prop({ enum: Object.values(SignatureMode) }) mode?: SignatureMode;

  // Mode PKI — giống PartyBSignature
  @Prop() signedPdfUrl?: string;
  @Prop() signedPdfPublicId?: string;
  @Prop({ trim: true, default: '' }) signerCertCN: string;
  @Prop({ trim: true, default: '' }) signerCertSerial: string;
  @Prop({ trim: true, default: '' }) signerCertIssuer: string;
  @Prop() certNotBefore?: Date;
  @Prop() certNotAfter?: Date;
  @Prop() signingTime?: Date;
  @Prop({ default: false }) chainValidated: boolean;

  // Mode SIMPLE
  @Prop({ type: SimpleSignatureRecordSchema }) simpleSignature?: SimpleSignatureRecord;

  @Prop() uploadedAt?: Date;
  @Prop() verifiedAt?: Date;
  @Prop({ trim: true, default: '' }) rejectReason: string;
}

export const PartyASignatureSchema = SchemaFactory.createForClass(PartyASignature);

/** Lịch thanh toán mặc định (Điều 3.2) — Đợt 1: 50% ký HĐ, Đợt 2: 40% nghiệm thu, Đợt 3: 10% sau 5 ngày */
export const DEFAULT_PAYMENT_SCHEDULE: { percent: number; timing: string }[] = [
  { percent: 50, timing: 'ngay khi ký hợp đồng' },
  { percent: 40, timing: 'khi nghiệm thu' },
  { percent: 10, timing: 'sau 05 ngày kể từ ngày nghiệm thu' },
];

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

  /** Điều 3.2 — lịch thanh toán chia đợt, mặc định 3 đợt (50/40/10) — admin có thể chỉnh % và mốc thời gian */
  @Prop({ type: [PaymentInstallmentSchema], default: () => DEFAULT_PAYMENT_SCHEDULE })
  paymentSchedule: PaymentInstallment[];

  /** Điều 3.3 — thông tin thanh toán: admin chọn Công ty hoặc Cá nhân, giá trị bên dưới set theo lựa chọn */
  @Prop({ enum: Object.values(PaymentInfoType), default: PaymentInfoType.COMPANY })
  paymentInfoType: PaymentInfoType;

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

  // ── Ký số (PAdES) ──────────────────────────────────────────────────────────
  /** PDF chính tắc chưa ký — sinh 1 lần duy nhất khi chuyển FINAL, không regenerate sau đó */
  @Prop() unsignedPdfUrl?: string;
  @Prop() unsignedPdfPublicId?: string;
  @Prop() unsignedPdfGeneratedAt?: Date;

  @Prop({ type: PartyBSignatureSchema, default: () => ({}) })
  partyBSignature: PartyBSignature;

  @Prop({ type: PartyASignatureSchema, default: () => ({}) })
  partyASignature: PartyASignature;

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
