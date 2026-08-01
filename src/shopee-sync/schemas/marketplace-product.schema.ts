import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MarketplaceProductDocument = MarketplaceProduct & Document;

/** Only Shopee today — kept as an enum (not a free string) so a future channel
 * (e.g. TikTok Shop) is a deliberate, typed addition, not a silent free-text value. */
export enum MarketplaceChannel {
  SHOPEE = 'SHOPEE',
}

/** Lifecycle of a mirrored product relative to the most recent full snapshots.
 * Never hard-deleted — see docs/shopee-sync-flow.md "Missing product" rule. */
export enum MarketplaceProductSyncStatus {
  ACTIVE = 'ACTIVE',
  MISSING_ONCE = 'MISSING_ONCE',
  ARCHIVE_CANDIDATE = 'ARCHIVE_CANDIDATE',
  ARCHIVED = 'ARCHIVED',
}

@Schema({ _id: false })
export class MarketplaceDimension {
  @Prop({ type: String, default: null }) width: string | null;
  @Prop({ type: String, default: null }) length: string | null;
  @Prop({ type: String, default: null }) height: string | null;
}
export const MarketplaceDimensionSchema = SchemaFactory.createForClass(MarketplaceDimension);

/** One Shopee variation dimension (e.g. "Màu sắc" → ["Đỏ","Xanh"]) — `MarketplaceVariant.tierIndexes[n]`
 * indexes into dimension `n`'s `options`. Needed to publish colors/sizes to the real catalog
 * (see `ShopeeCatalogPublishService`); Shopee caps this at 2 dimensions in practice. */
@Schema({ _id: false })
export class MarketplaceTierVariation {
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ type: [String], default: [] }) options: string[];
}
export const MarketplaceTierVariationSchema = SchemaFactory.createForClass(MarketplaceTierVariation);

/**
 * Read-only mirror of a Shopee product, upserted only by the sync commit step.
 * Product key is `channel + shopId + externalProductId` — deliberately NOT name/SKU
 * (Shopee SKU can be blank or change; see section 11 of the feature spec).
 */
@Schema({ timestamps: true, collection: 'marketplace_products' })
export class MarketplaceProduct {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(MarketplaceChannel), type: String, default: MarketplaceChannel.SHOPEE })
  channel: MarketplaceChannel;

  @Prop({ required: true, trim: true })
  shopId: string;

  @Prop({ required: true, trim: true })
  externalProductId: string;

  /** Manual link to a real Luxe Glow catalog Product. Never set automatically by
   * the sync pipeline (see README "Phạm vi không triển khai"). */
  @Prop({ type: Types.ObjectId, ref: 'Product', default: null })
  internalProductId: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true })
  rawStatus: number;

  @Prop({ type: String, default: null })
  parentSku: string | null;

  @Prop({ type: String, default: null })
  coverImageId: string | null;

  @Prop({ type: String, default: null })
  coverImageUrl: string | null;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  descriptionType: string | null;

  @Prop({ type: [Number], default: [] })
  categoryIds: number[];

  @Prop({ type: [String], default: [] })
  categoryNames: string[];

  @Prop({ type: Number, default: null })
  condition: number | null;

  @Prop({ type: String, default: null })
  brandId: string | null;

  @Prop({ type: String, default: null })
  brandName: string | null;

  @Prop({ required: true }) priceMin: string;
  @Prop({ required: true }) priceMax: string;
  @Prop({ required: true }) sellingPriceMin: string;
  @Prop({ required: true }) sellingPriceMax: string;

  @Prop({ required: true, min: 0 }) availableStock: number;
  @Prop({ required: true, min: 0 }) sellerStock: number;
  @Prop({ required: true, min: 0 }) shopeeStock: number;

  @Prop({ default: 0 }) soldCount: number;
  @Prop({ default: 0 }) viewCount: number;
  @Prop({ default: 0 }) likedCount: number;

  @Prop({ type: String, default: null }) weightValue: string | null;
  @Prop({ type: Number, default: null }) weightUnit: number | null;

  @Prop({ type: MarketplaceDimensionSchema, default: () => ({ width: null, length: null, height: null }) })
  dimension: MarketplaceDimension;

  @Prop({ type: [MarketplaceTierVariationSchema], default: [] })
  tierVariations: MarketplaceTierVariation[];

  @Prop({ default: false }) preOrder: boolean;
  @Prop({ type: Number, default: null }) daysToShip: number | null;

  /** Shopee's own `create_time`/`modify_time` (unix seconds) — modifyTime drives diffing. */
  @Prop({ required: true }) sourceCreatedAt: number;
  @Prop({ required: true, index: true }) sourceModifiedAt: number;

  /** Hash of the normalized payload — extra change-detection safety net alongside modifyTime. */
  @Prop({ required: true }) sourceHash: string;

  @Prop({ required: true, enum: Object.values(MarketplaceProductSyncStatus), type: String, default: MarketplaceProductSyncStatus.ACTIVE })
  syncStatus: MarketplaceProductSyncStatus;

  @Prop({ required: true }) lastSyncedAt: Date;
  @Prop({ type: Date, default: null }) lastDetailSyncedAt: Date | null;
  @Prop({ default: false }) lastDetailSyncFailed: boolean;

  /** Id of the sync session that FIRST observed this product missing — used to tell
   * "missing once" apart from "missing two full syncs in a row". Cleared once the
   * product reappears. */
  @Prop({ type: String, default: null }) missingSinceSyncSessionId: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const MarketplaceProductSchema = SchemaFactory.createForClass(MarketplaceProduct);

MarketplaceProductSchema.index({ channel: 1, shopId: 1, externalProductId: 1 }, { unique: true });
MarketplaceProductSchema.index({ channel: 1, shopId: 1, syncStatus: 1 });
