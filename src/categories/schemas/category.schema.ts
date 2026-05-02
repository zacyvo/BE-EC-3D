import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true, trim: true }) name: string;
  @Prop({ lowercase: true, trim: true }) slug: string;
  @Prop() description?: string;
  @Prop({ default: true }) isActive: boolean;
  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt?: Date;
  @Prop() deletedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ isDeleted: 1, isActive: 1 });
CategorySchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
  next();
});
