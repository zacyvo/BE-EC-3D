import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ExternalRevenueDocument = ExternalRevenue & Document;

export enum ExternalSource {
  SHOPEE = 'SHOPEE',
  TIKTOK = 'TIKTOK',
  ZALO = 'ZALO',
  FACEBOOK = 'FACEBOOK',
  INSTAGRAM = 'INSTAGRAM',
  OTHER = 'OTHER',
}

@Schema({ timestamps: true })
export class ExternalRevenue {
  @Prop({ required: true, enum: Object.values(ExternalSource) })
  source: ExternalSource;

  @Prop({ trim: true, default: '' })
  note: string;

  @Prop({ required: true, min: 1, max: 12 })
  month: number;

  @Prop({ required: true, min: 2000 })
  year: number;

  @Prop({ required: true, min: 0 })
  revenue: number;

  @Prop({ required: true, min: 0 })
  cost: number;

  /** Platform commission / listing fee (giá sàn) */
  @Prop({ required: true, min: 0 })
  platformFee: number;

  @Prop({ type: Types.ObjectId, ref: 'Staff' })
  createdBy?: Types.ObjectId;
}

export const ExternalRevenueSchema = SchemaFactory.createForClass(ExternalRevenue);

// Index for fast year-based queries
ExternalRevenueSchema.index({ year: 1, month: 1 });
