import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cart, CartDocument } from './schemas/cart.schema';
import { ProductsService } from '../products/products.service';
import { IsMongoId, IsNumber, Min } from 'class-validator';

export class AddToCartDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) quantity: number;
}

export class UpdateCartItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(0) quantity: number;
}

@Injectable()
export class CartService {
  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    private readonly productsService: ProductsService,
  ) {}

  async getCart(userId: string): Promise<CartDocument> {
    let cart = await this.cartModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
    if (!cart) {
      cart = await this.cartModel.create({ userId: new Types.ObjectId(userId), items: [] });
    }
    return cart;
  }

  async addItem(userId: string, dto: AddToCartDto): Promise<CartDocument> {
    const product = await this.productsService.findById(dto.productId, false);
    if (product.stock < dto.quantity) {
      throw new BadRequestException('Insufficient stock');
    }

    let cart = await this.cartModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
    if (!cart) {
      cart = new this.cartModel({ userId: new Types.ObjectId(userId), items: [] });
    }

    const existingIdx = cart.items.findIndex(
      (item) => item.productId.toString() === dto.productId,
    );

    if (existingIdx >= 0) {
      cart.items[existingIdx].quantity += dto.quantity;
    } else {
      cart.items.push({
        productId: new Types.ObjectId(dto.productId),
        productName: product.name,
        productImage: product.images[0] || '',
        quantity: dto.quantity,
        price: product.finalPrice,
        slug: product.slug,
      });
    }

    return cart.save();
  }

  async updateItem(userId: string, dto: UpdateCartItemDto): Promise<CartDocument> {
    const cart = await this.getCart(userId);

    if (dto.quantity === 0) {
      cart.items = cart.items.filter(
        (item) => item.productId.toString() !== dto.productId,
      );
    } else {
      const idx = cart.items.findIndex(
        (item) => item.productId.toString() === dto.productId,
      );
      if (idx < 0) throw new NotFoundException('Item not in cart');
      cart.items[idx].quantity = dto.quantity;
    }

    return cart.save();
  }

  async clearCart(userId: string): Promise<void> {
    await this.cartModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { $set: { items: [] } },
    ).exec();
  }
}
