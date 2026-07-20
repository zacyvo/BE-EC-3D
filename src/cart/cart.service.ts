import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cart, CartDocument } from './schemas/cart.schema';
import { ProductsService } from '../products/products.service';
import { IsMongoId, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class AddToCartDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) quantity: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
}

export class UpdateCartItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(0) quantity: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
}

/** True when both items refer to the same product + selected variant. */
function sameLine(
  item: { productId: Types.ObjectId; color?: string; size?: string },
  productId: string,
  color?: string,
  size?: string,
): boolean {
  return (
    item.productId.toString() === productId &&
    (item.color || undefined) === (color || undefined) &&
    (item.size || undefined) === (size || undefined)
  );
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

  /** Validates the selected color/size against the product's configured options
   * (if any) and resolves the image to snapshot for this line item. */
  private resolveVariant(
    product: { colors: { name: string; images: string[] }[]; sizes: string[]; images: string[] },
    color?: string,
    size?: string,
  ): { color?: string; size?: string; image: string } {
    let matchedColor: { name: string; images: string[] } | undefined;
    if (product.colors?.length) {
      matchedColor = product.colors.find((c) => c.name === color);
      if (!matchedColor) throw new BadRequestException('Vui lòng chọn màu hợp lệ');
    }
    if (product.sizes?.length && !product.sizes.includes(size || '')) {
      throw new BadRequestException('Vui lòng chọn size hợp lệ');
    }
    const image = matchedColor?.images?.[0] || product.images[0] || '';
    return {
      ...(matchedColor ? { color: matchedColor.name } : {}),
      ...(product.sizes?.length ? { size } : {}),
      image,
    };
  }

  async addItem(userId: string, dto: AddToCartDto): Promise<CartDocument> {
    const product = await this.productsService.findById(dto.productId, false);
    if (product.stock < dto.quantity) {
      throw new BadRequestException('Insufficient stock');
    }
    const variant = this.resolveVariant(product, dto.color, dto.size);

    let cart = await this.cartModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
    if (!cart) {
      cart = new this.cartModel({ userId: new Types.ObjectId(userId), items: [] });
    }

    const existingIdx = cart.items.findIndex((item) =>
      sameLine(item, dto.productId, variant.color, variant.size),
    );

    if (existingIdx >= 0) {
      cart.items[existingIdx].quantity += dto.quantity;
    } else {
      cart.items.push({
        productId: new Types.ObjectId(dto.productId),
        productName: product.name,
        productImage: variant.image,
        quantity: dto.quantity,
        price: product.finalPrice,
        slug: product.slug,
        ...(variant.color ? { color: variant.color } : {}),
        ...(variant.size ? { size: variant.size } : {}),
      });
    }

    return cart.save();
  }

  async updateItem(userId: string, dto: UpdateCartItemDto): Promise<CartDocument> {
    const cart = await this.getCart(userId);

    if (dto.quantity === 0) {
      cart.items = cart.items.filter(
        (item) => !sameLine(item, dto.productId, dto.color, dto.size),
      );
    } else {
      const idx = cart.items.findIndex((item) =>
        sameLine(item, dto.productId, dto.color, dto.size),
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
