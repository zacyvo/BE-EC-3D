import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeSyncItemDocument = ShopeeSyncItem & Document;

export enum ShopeeSyncItemStatus {
  NEW = 'NEW',
  CHANGED = 'CHANGED',
  UNCHANGED = 'UNCHANGED',
  MISSING = 'MISSING',
  FAILED = 'FAILED',
}

/**
 * One row per Shopee product observed during a sync session — the staging area.
 * `productPayload` holds the normalized Product+Variants+Images the extension
 * uploaded for this product; nothing here is copied into the real
 * `marketplace_products/variants/images` collections until commit.
 */
@Schema({ timestamps: true, collection: 'shopee_sync_items' })
export class ShopeeSyncItem {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ShopeeSyncSession', required: true, index: true })
  syncSessionId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  externalProductId: string;

  @Prop({ required: true, enum: Object.values(ShopeeSyncItemStatus), type: String })
  status: ShopeeSyncItemStatus;

  @Prop({ type: Number, default: null })
  sourceModifiedAt: number | null;

  /** True once a successful (non-`failed`) Detail upload has landed for a NEW/CHANGED item.
   * Irrelevant for UNCHANGED/MISSING items — no Detail call is ever made for those. */
  @Prop({ default: false })
  detailUploaded: boolean;

  /** Normalized MarketplaceProductUploadDto payload, staged until commit. Cleared on cancel. */
  @Prop({ type: Object, default: null })
  productPayload: Record<string, unknown> | null;

  @Prop({ type: String, default: null })
  errorCode: string | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const ShopeeSyncItemSchema = SchemaFactory.createForClass(ShopeeSyncItem);

ShopeeSyncItemSchema.index({ syncSessionId: 1, externalProductId: 1 }, { unique: true });
ShopeeSyncItemSchema.index({ syncSessionId: 1, status: 1 });
