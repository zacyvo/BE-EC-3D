import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CartDocument = Cart & Document;

@Schema({ _id: false })
export class CartItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true }) productId: Types.ObjectId;
  @Prop({ required: true }) productName: string;
  @Prop({ required: true }) productImage: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true }) price: number; // finalPrice at time of add
  @Prop({ required: true }) slug: string;
  /** Selected color/size variant, if the product has variant options. */
  @Prop() color?: string;
  @Prop() size?: string;
}

const CartItemSchema = SchemaFactory.createForClass(CartItem);

@Schema({ timestamps: true })
export class Cart {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: [CartItemSchema], default: [] })
  items: CartItem[];
}

export const CartSchema = SchemaFactory.createForClass(Cart);
CartSchema.index({ userId: 1 });
