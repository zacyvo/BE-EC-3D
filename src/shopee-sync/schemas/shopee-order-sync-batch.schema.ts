import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeOrderSyncBatchDocument = ShopeeOrderSyncBatch & Document;

export enum ShopeeOrderRowStatus {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  /** Order code matches an issue the staff previously dismissed — left untouched. */
  DISMISSED = 'DISMISSED',
  FAILED = 'FAILED',
}

/** Outcome of one order code found in an uploaded file (one or more source rows
 * grouped together — a multi-item order spans multiple Excel rows). */
@Schema({ _id: false })
export class ShopeeOrderRowResult {
  @Prop({ required: true }) orderCode: string;
  @Prop({ required: true, enum: Object.values(ShopeeOrderRowStatus), type: String }) status: ShopeeOrderRowStatus;
  @Prop() message?: string;
  @Prop({ type: Types.ObjectId, ref: 'Order' }) orderId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'ShopeeOrderSyncIssue' }) issueId?: Types.ObjectId;
}

const ShopeeOrderRowResultSchema = SchemaFactory.createForClass(ShopeeOrderRowResult);

/** Audit record of one Excel upload — lets admins see what happened to every order
 * code in the file without re-parsing it. */
@Schema({ timestamps: true, collection: 'shopee_order_sync_batches' })
export class ShopeeOrderSyncBatch {
  _id: Types.ObjectId;

  @Prop({ required: true }) fileName: string;
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true }) uploadedBy: Types.ObjectId;

  @Prop({ required: true }) totalRows: number;
  @Prop({ required: true }) totalOrders: number;
  @Prop({ default: 0 }) createdCount: number;
  @Prop({ default: 0 }) updatedCount: number;
  @Prop({ default: 0 }) needsReviewCount: number;
  @Prop({ default: 0 }) dismissedCount: number;
  @Prop({ default: 0 }) failedCount: number;

  @Prop({ type: [ShopeeOrderRowResultSchema], default: [] }) rows: ShopeeOrderRowResult[];

  createdAt: Date;
  updatedAt: Date;
}

export const ShopeeOrderSyncBatchSchema = SchemaFactory.createForClass(ShopeeOrderSyncBatch);
ShopeeOrderSyncBatchSchema.index({ createdAt: -1 });
