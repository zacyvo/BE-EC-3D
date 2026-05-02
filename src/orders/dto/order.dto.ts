import {
  IsString,
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
  Min,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '../schemas/order.schema';

export class OrderItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) quantity: number;
}

export class ShippingInfoDto {
  @IsString() recipientName: string;
  @IsString() phone: string;
  @IsString() street: string;
  @IsString() ward: string;
  @IsString() district: string;
  @IsString() city: string;
  @IsOptional() @IsString() note?: string;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => ShippingInfoDto)
  shippingInfo: ShippingInfoDto;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() csNote?: string;
  @IsOptional() @IsString() cancelReason?: string;
}
