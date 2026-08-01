import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MarketplaceVariantDocument = MarketplaceVariant & Document;

/**
 * Read-only mirror of one Shopee `model` (variant), including the synthetic
 * default model Shopee returns for products with no variation options
 * (`{ is_default: true, name: "" }`) — that row is NOT discarded, it still
 * carries the real variant id / price / stock (see feature spec section 12).
 */
@Schema({ timestamps: true, collection: 'marketplace_variants' })
export class MarketplaceVariant {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MarketplaceProduct', required: true, index: true })
  marketplaceProductId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  externalVariantId: string;

  /** Manual link to a Luxe Glow variant concept, if one is ever introduced. Unused in v1. */
  @Prop({ type: String, default: null })
  internalVariantId: string | null;

  /** null when Shopee's own model name is empty (the synthetic default model). */
  @Prop({ type: String, default: null })
  variantName: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: [Number], default: [] })
  tierIndexes: number[];

  @Prop({ type: String, default: null })
  imageId: string | null;

  @Prop({ type: String, default: null })
  imageUrl: string | null;

  @Prop({ required: true }) normalPrice: string;
  @Prop({ required: true }) promotionPrice: string;
  @Prop({ required: true }) effectivePrice: string;

  @Prop({ required: true, min: 0 }) availableStock: number;
  @Prop({ required: true, min: 0 }) sellerStock: number;
  @Prop({ required: true, min: 0 }) shopeeStock: number;
  @Prop({ required: true, min: 0 }) reservedStock: number;

  @Prop({ type: Number, default: null })
  soldCount: number | null;

  @Prop({ type: Number, default: null })
  availableStatus: number | null;

  @Prop({ default: false }) preOrder: boolean;
  @Prop({ type: Number, default: null }) daysToShip: number | null;

  @Prop({ default: false }) isDefault: boolean;

  /** Set to false when a later Detail sync no longer lists this variant — never hard-deleted. */
  @Prop({ default: true }) isActive: boolean;

  @Prop({ required: true }) sourceHash: string;

  createdAt: Date;
  updatedAt: Date;
}

export const MarketplaceVariantSchema = SchemaFactory.createForClass(MarketplaceVariant);

MarketplaceVariantSchema.index({ marketplaceProductId: 1, externalVariantId: 1 }, { unique: true });
