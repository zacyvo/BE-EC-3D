import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MarketplaceProductImageDocument = MarketplaceProductImage & Document;

export enum MarketplaceImageType {
  COVER = 'COVER',
  GALLERY = 'GALLERY',
  VARIANT = 'VARIANT',
}

/**
 * One resolved Shopee image (cover / gallery / variant). `sourceUrl` is always
 * populated by `ShopeeImageResolver` (id → URL via configurable template);
 * `cachedUrl` stays null in v1 — see feature spec section 13, this repo does not
 * download/re-host images yet, only stores enough to do so later (S3/R2/Cloudinary).
 */
@Schema({ timestamps: true, collection: 'marketplace_product_images' })
export class MarketplaceProductImage {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MarketplaceProduct', required: true, index: true })
  marketplaceProductId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MarketplaceVariant', default: null })
  marketplaceVariantId: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  sourceImageId: string;

  @Prop({ required: true, trim: true })
  sourceUrl: string;

  @Prop({ type: String, default: null })
  cachedUrl: string | null;

  @Prop({ required: true, enum: Object.values(MarketplaceImageType), type: String })
  imageType: MarketplaceImageType;

  @Prop({ required: true, min: 0 })
  position: number;

  @Prop({ type: String, default: null })
  sourceHash: string | null;

  /** Set to false when a later sync no longer references this image — never hard-deleted. */
  @Prop({ default: true })
  isActive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const MarketplaceProductImageSchema = SchemaFactory.createForClass(MarketplaceProductImage);

MarketplaceProductImageSchema.index({ marketplaceProductId: 1, imageType: 1, position: 1 });
MarketplaceProductImageSchema.index(
  { marketplaceProductId: 1, sourceImageId: 1, imageType: 1 },
  { unique: true },
);
