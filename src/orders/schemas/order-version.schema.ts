import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderVersionDocument = OrderVersion & Document;

@Schema({ timestamps: true })
export class OrderVersion {
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true }) orderId: Types.ObjectId;
  @Prop({ required: true }) versionNumber: number;
  @Prop({ type: Object, required: true }) snapshot: Record<string, unknown>;
  @Prop({ required: true }) changedBy: string;
  @Prop({ default: 'user', enum: ['user', 'staff'] }) changedByType: string;
  @Prop() changeNote?: string;
  createdAt: Date;
}

export const OrderVersionSchema = SchemaFactory.createForClass(OrderVersion);
OrderVersionSchema.index({ orderId: 1, versionNumber: -1 });
