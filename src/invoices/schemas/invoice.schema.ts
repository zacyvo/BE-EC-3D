import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvoiceDocument = Invoice & Document;

export enum InvoiceSource {
  SHOPEE    = 'SHOPEE',
  FACEBOOK  = 'FACEBOOK',
  TAOBAO    = 'TAOBAO',
  ALIBABA   = 'ALIBABA',
  TIKI      = 'TIKI',
  LAZADA    = 'LAZADA',
  TIKTOK    = 'TIKTOK',
  ZALO      = 'ZALO',
  DIRECT    = 'DIRECT',
  OTHER     = 'OTHER',
}

export enum InvoiceCategory {
  MATERIAL_IMPORT   = 'MATERIAL_IMPORT',    // Nhập nguyên liệu (nhựa, ...)
  COMPONENT_IMPORT  = 'COMPONENT_IMPORT',   // Nhập linh kiện
  EQUIPMENT         = 'EQUIPMENT',          // Thiết bị / máy móc
  SHIPPING          = 'SHIPPING',           // Vận chuyển
  UTILITIES         = 'UTILITIES',          // Điện, nước, internet
  MARKETING         = 'MARKETING',          // Marketing / quảng cáo
  SALARY            = 'SALARY',             // Lương
  OTHER             = 'OTHER',              // Khác
}

@Schema({ timestamps: true })
export class Invoice {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 200 })
  title: string;

  @Prop({ required: true, enum: Object.values(InvoiceCategory) })
  category: InvoiceCategory;

  @Prop({ trim: true, maxlength: 100, default: '' })
  customCategory: string;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ required: true, enum: Object.values(InvoiceSource) })
  source: InvoiceSource;

  @Prop({ trim: true, maxlength: 100, default: '' })
  customSource: string;

  @Prop({ required: true })
  date: Date;

  @Prop({ trim: true, maxlength: 1000, default: '' })
  note: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

InvoiceSchema.index({ date: -1 });
InvoiceSchema.index({ category: 1 });
InvoiceSchema.index({ source: 1 });
