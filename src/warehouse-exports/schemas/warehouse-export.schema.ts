import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WarehouseExportDocument = WarehouseExport & Document;

@Schema({ _id: false })
export class ExportItem {
  @Prop({ required: true }) productId: string;
  @Prop({ required: true, trim: true }) productCode: string; // last 6 chars of _id
  @Prop({ required: true, trim: true }) productName: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true, min: 0 }) shippingPrice: number;
  @Prop({ required: true, min: 0 }) costPrice: number;
}

export const ExportItemSchema = SchemaFactory.createForClass(ExportItem);

@Schema({ timestamps: true })
export class WarehouseExport {
  _id: Types.ObjectId;

  @Prop({ type: [ExportItemSchema], required: true, default: [] })
  items: ExportItem[];

  @Prop({ required: true, trim: true }) recipientName: string;
  @Prop({ trim: true, default: '' }) recipientPhone: string;
  @Prop({ trim: true, default: '' }) recipientAddress: string;

  @Prop({ trim: true, default: '' }) note: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const WarehouseExportSchema = SchemaFactory.createForClass(WarehouseExport);

WarehouseExportSchema.index({ createdAt: -1 });
WarehouseExportSchema.index({ createdBy: 1 });
