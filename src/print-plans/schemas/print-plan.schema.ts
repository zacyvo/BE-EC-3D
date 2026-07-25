import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PrintPlanDocument = PrintPlan & Document;

export enum PrintPlanStatus {
  NEW      = 'NEW',
  PRINTING = 'PRINTING',
  PRINTED  = 'PRINTED',
  ERROR    = 'ERROR',
}

@Schema({ timestamps: true })
export class PrintPlan {
  _id: Types.ObjectId;

  /** Mã kế hoạch in, VD: 483920/IN-2026 — sinh ngẫu nhiên (không tuần tự), unique. */
  @Prop({ required: true, unique: true, trim: true })
  code: string;

  /** Liên kết tới sản phẩm thật nếu được chọn từ danh sách — optional vì tên có thể nhập tay. */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  productId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  productName: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true })
  deliveryDate: Date;

  /** Nguồn đơn hàng: Shopee, TikTok Shop, Đơn sỉ, ... — free text để dễ mở rộng. */
  @Prop({ required: true, trim: true })
  source: string;

  /** Ghi chú nhiều dòng cho người thực hiện in (giữ nguyên xuống dòng khi hiển thị). */
  @Prop({ trim: true, default: '' })
  note: string;

  @Prop({ default: PrintPlanStatus.NEW, enum: Object.values(PrintPlanStatus) })
  status: PrintPlanStatus;

  /** Lý do lỗi khi status = ERROR. */
  @Prop({ trim: true, default: '' })
  errorReason: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const PrintPlanSchema = SchemaFactory.createForClass(PrintPlan);
PrintPlanSchema.index({ status: 1 });
PrintPlanSchema.index({ deliveryDate: 1 });
PrintPlanSchema.index({ createdAt: -1 });
PrintPlanSchema.index({ isDeleted: 1 });
PrintPlanSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
  next();
});
