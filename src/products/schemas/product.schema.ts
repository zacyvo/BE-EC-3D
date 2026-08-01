import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductDocument = Product & Document;

/** A selectable color option. When `images` is non-empty, selecting this color
 * in the storefront swaps the product gallery to these images; otherwise the
 * product's default `images` are shown. */
@Schema({ _id: false })
export class ProductColor {
  @Prop({ required: true, trim: true }) name: string;
  @Prop() hexCode?: string;
  @Prop({ type: [String], default: [] }) images: string[];
}

export const ProductColorSchema = SchemaFactory.createForClass(ProductColor);

export enum SocialPlatform {
  SHOPEE = 'SHOPEE',
  THREADS = 'THREADS',
  FACEBOOK = 'FACEBOOK',
  TIKTOK = 'TIKTOK',
  OTHER = 'OTHER',
}

@Schema({ _id: false })
export class ProductSocial {
  @Prop({ required: true, enum: SocialPlatform, type: String }) name: SocialPlatform;
  @Prop() id?: string;
  @Prop() link?: string;
}

export const ProductSocialSchema = SchemaFactory.createForClass(ProductSocial);

@Schema({ timestamps: true })
export class Product {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true }) name: string;
  @Prop({ required: true, unique: true, lowercase: true }) slug: string;
  @Prop({ type: [String], default: [] })
  images: string[];

  /** Optional product video URL (e.g. synced from Shopee's `video_list`). */
  @Prop() video?: string;

  /** Selectable color variants. Empty = product has no color options (default behavior). */
  @Prop({ type: [ProductColorSchema], default: [] })
  colors: ProductColor[];

  /** Selectable size labels (e.g. "S", "M", "L"). Empty = no size options (default behavior). */
  @Prop({ type: [String], default: [] })
  sizes: string[];

  /** Linked social/marketplace channels for this product (e.g. its Shopee listing). */
  @Prop({ type: [ProductSocialSchema], default: [] })
  socials: ProductSocial[];

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  category: Types.ObjectId;

  @Prop({ required: true, min: 0 }) costPrice: number;
  @Prop({ required: true, min: 0 }) sellingPrice: number;
  @Prop({ default: 0, min: 0, max: 100 }) discountPercent: number;
  @Prop({ required: true, min: 0 }) finalPrice: number;
  @Prop({ default: 0 }) profit: number;
  @Prop({ default: 0 }) profitPercent: number;

  @Prop({ required: true, min: 0 }) stock: number;
  @Prop() eta?: string; // Estimated delivery time
  @Prop() description?: string;
  @Prop() shortDescription?: string;
  @Prop({ default: true }) isActive: boolean;
  @Prop({ default: 0 }) viewCount: number;
  @Prop({ default: 0 }) orderCount: number;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt?: Date;
  @Prop() deletedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ slug: 1 });
ProductSchema.index({ category: 1 });
ProductSchema.index({ isDeleted: 1, isActive: 1 });
ProductSchema.index({ name: 'text', description: 'text' });

ProductSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});
