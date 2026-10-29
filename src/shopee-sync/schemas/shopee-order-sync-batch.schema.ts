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

export enum ShopeeOrderSyncSource {
  EXCEL = 'EXCEL',
  OPEN_API = 'OPEN_API',
}

/** Excel imports run inside the request (created → COMPLETED at once); Open API syncs run
 * in the background, so the batch exists as RUNNING while orders are being fetched. */
export enum ShopeeOrderSyncBatchStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/** Audit record of one Excel upload or one Open API sync run — lets admins see what
 * happened to every order code without re-parsing/re-fetching it. */
@Schema({ timestamps: true, collection: 'shopee_order_sync_batches' })
export class ShopeeOrderSyncBatch {
  _id: Types.ObjectId;

  /** File name for Excel; a human label (e.g. time range) for Open API runs. */
  @Prop({ required: true }) fileName: string;
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true }) uploadedBy: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(ShopeeOrderSyncSource), type: String, default: ShopeeOrderSyncSource.EXCEL })
  source: ShopeeOrderSyncSource;
  @Prop({ required: true, enum: Object.values(ShopeeOrderSyncBatchStatus), type: String, default: ShopeeOrderSyncBatchStatus.COMPLETED })
  status: ShopeeOrderSyncBatchStatus;
  @Prop() errorMessage?: string;
  /** Open API runs: the update_time window that was synced. */
  @Prop() rangeFrom?: Date;
  @Prop() rangeTo?: Date;
  @Prop({ default: false }) automatic: boolean;

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
