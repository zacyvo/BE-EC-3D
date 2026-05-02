import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true }) name: string;
  @Prop({ required: true, unique: true, lowercase: true }) slug: string;
  @Prop({ type: [String], default: [], validate: [(v: string[]) => v.length >= 1, 'At least 1 image'] })
  images: string[];

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
