import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum FilamentType {
  PETG_BASIC = 'PETG_BASIC', // PETG-Basic
  PLA_MATTE  = 'PLA_MATTE',  // PLA Matte
  PLA_SILK   = 'PLA_SILK',   // PLA Silk
}

export enum FilamentUnitStatus {
  NEW      = 'NEW',      // Mới
  IN_USE   = 'IN_USE',   // Đang dùng
  DEPLETED = 'DEPLETED', // Hết
}

export type FilamentImportDocument = FilamentImport & Document;
export type FilamentUnitDocument = FilamentUnit & Document;

@Schema({ _id: false })
export class FilamentImportItem {
  @Prop({ required: true, enum: Object.values(FilamentType) }) type: FilamentType;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true, min: 0 }) unitPrice: number;
  @Prop({ required: true, min: 0 }) totalPrice: number;
}

export const FilamentImportItemSchema = SchemaFactory.createForClass(FilamentImportItem);

/** Một phiếu nhập filament — có thể gồm nhiều loại, tự động sinh 1 hóa đơn (Invoice) liên kết. */
@Schema({ timestamps: true })
export class FilamentImport {
  _id: Types.ObjectId;

  @Prop({ type: [FilamentImportItemSchema], required: true, default: [] })
  items: FilamentImportItem[];

  @Prop({ required: true, min: 0 })
  totalAmount: number;

  @Prop({ required: true })
  date: Date;

  @Prop({ trim: true, maxlength: 1000, default: '' })
  note: string;

  @Prop({ type: Types.ObjectId, ref: 'Invoice' })
  invoiceId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const FilamentImportSchema = SchemaFactory.createForClass(FilamentImport);
FilamentImportSchema.index({ date: -1 });
FilamentImportSchema.index({ createdAt: -1 });

/**
 * Một cuộn filament vật lý, sinh ra từ FilamentImport (1 unit / cuộn) để theo dõi
 * vòng đời riêng: Mới -> Đang dùng (ghi nhận thời gian xuất) -> Hết.
 */
@Schema({ timestamps: true })
export class FilamentUnit {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(FilamentType) })
  type: FilamentType;

  @Prop({ required: true, min: 0 })
  unitPrice: number;

  @Prop({ default: FilamentUnitStatus.NEW, enum: Object.values(FilamentUnitStatus) })
  status: FilamentUnitStatus;

  @Prop({ type: Types.ObjectId, ref: 'FilamentImport', required: true })
  importId: Types.ObjectId;

  @Prop()
  exportedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  exportedBy?: Types.ObjectId;

  @Prop()
  depletedAt?: Date;

  @Prop({ trim: true, maxlength: 500, default: '' })
  note: string;

  createdAt: Date;
  updatedAt: Date;
}

export const FilamentUnitSchema = SchemaFactory.createForClass(FilamentUnit);
FilamentUnitSchema.index({ type: 1, status: 1 });
FilamentUnitSchema.index({ importId: 1 });
FilamentUnitSchema.index({ createdAt: 1 });
FilamentUnitSchema.index({ exportedAt: -1 });
