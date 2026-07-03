import {
  IsString,
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
  Min,
  Max,
  IsEnum,
  IsDateString,
  Matches,
  ArrayUnique,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '../schemas/order.schema';

export class OrderItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) quantity: number;
  @IsOptional() @IsString() note?: string;
}

export class ShippingInfoDto {
  @IsString() recipientName: string;
  @IsString()
  @Matches(/^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone: string;
  @IsString() street: string;
  @IsString() ward: string;
  @IsOptional() @IsString() district?: string;
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

  @IsOptional() @IsString() customerNote?: string;

  /** Coupon codes to apply to this order */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  couponCodes?: string[];
}

export class DeliveryDto {
  @IsOptional() @IsString() carrierName?: string;
  @IsOptional() @IsString() trackingCode?: string;
  @IsOptional() @IsString() trackingUrl?: string;
  @IsOptional() @IsDateString() estimatedDeliveryDate?: string;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() csNote?: string;
  @IsOptional() @IsString() cancelReason?: string;
  @IsOptional() @ValidateNested() @Type(() => DeliveryDto) delivery?: DeliveryDto;
  @IsOptional() @IsNumber() @Min(0) paidAmount?: number;
}

export class GuestInfoDto {
  @IsString()
  @Matches(/^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone: string;

  @IsString() name: string;
}

export class AdminDirectDiscountDto {
  /** 'AMOUNT' = fixed VND amount, 'PERCENT' = percentage off */
  @IsEnum(['AMOUNT', 'PERCENT']) type: 'AMOUNT' | 'PERCENT';

  /** For AMOUNT: VND value. For PERCENT: 0–100. */
  @IsNumber() @Min(0) value: number;

  @IsOptional() @IsString() reason?: string;
}

export class AdminCreateOrderDto {
  /** ID of an existing user. Provide either userId OR guestInfo. */
  @IsOptional() @IsMongoId() userId?: string;

  /** Info to create a guest account when the phone does not exist in DB. */
  @IsOptional() @ValidateNested() @Type(() => GuestInfoDto) guestInfo?: GuestInfoDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => ShippingInfoDto)
  shippingInfo: ShippingInfoDto;

  @IsOptional() @IsString() customerNote?: string;
  @IsOptional() @IsString() adminNote?: string;

  /** Direct discount applied by admin (bypasses coupon system) */
  @IsOptional() @ValidateNested() @Type(() => AdminDirectDiscountDto)
  adminDiscount?: AdminDirectDiscountDto;

  /** Shipping fee added to the order total */
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;
}
