import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CustomOrderDocument = CustomOrder & Document;

export enum CustomOrderStatus {
  PENDING    = 'PENDING',
  REVIEWING  = 'REVIEWING',
  QUOTED     = 'QUOTED',
  ACCEPTED   = 'ACCEPTED',
  PROCESSING = 'PROCESSING',
  COMPLETED  = 'COMPLETED',
  CANCELLED  = 'CANCELLED',
}

@Schema({ timestamps: true })
export class CustomOrder {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  content: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ required: true, trim: true })
  contactName: string;

  @Prop({ required: true, trim: true })
  contactPhone: string;

  @Prop({ required: true, trim: true })
  contactEmail: string;

  @Prop({ default: CustomOrderStatus.PENDING, enum: Object.values(CustomOrderStatus) })
  status: CustomOrderStatus;

  @Prop({ trim: true })
  adminNote?: string;

  @Prop({ trim: true })
  cancelReason?: string;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const CustomOrderSchema = SchemaFactory.createForClass(CustomOrder);
CustomOrderSchema.index({ userId: 1, createdAt: -1 });
CustomOrderSchema.index({ status: 1 });
CustomOrderSchema.index({ isDeleted: 1 });
CustomOrderSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
  next();
});
