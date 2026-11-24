import {
  IsString, IsEnum, IsNumber, IsOptional, IsBoolean, IsInt, IsIn,
  IsDateString, IsArray, IsMongoId, Min, Max, ArrayUnique, ArrayMaxSize, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DiscountType, PromotionRegion, PROMOTION_PAYMENT_METHODS, PromotionPaymentMethod,
} from '../schemas/promotion.schema';

// ─── Conditions ───────────────────────────────────────────────────────────────

/** Program eligibility rules — omitted / 0 / false / [] = that rule is off. Sent as a whole object
 * (it replaces the program's previous conditions). */
export class PromotionConditionsDto {
  @IsOptional() @IsInt() @Min(0) @Max(3650) newAccountWithinDays?: number;
  @IsOptional() @IsBoolean() firstOrderOnly?: boolean;
  @IsOptional() @IsInt() @Min(0) minCompletedOrders?: number;
  @IsOptional() @IsInt() @Min(0) maxCompletedOrders?: number;
  @IsOptional() @IsNumber() @Min(0) minTotalSpent?: number;
  @IsOptional() @IsBoolean() birthdayMonthOnly?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(3650) inactiveDays?: number;
  @IsOptional() @IsBoolean() marketingOptInOnly?: boolean;

  @IsOptional() @IsInt() @Min(0) minItemQuantity?: number;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(200) @IsMongoId({ each: true }) productIds?: string[];
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsMongoId({ each: true }) categoryIds?: string[];
  @IsOptional() @IsEnum(PromotionRegion) region?: PromotionRegion;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(PROMOTION_PAYMENT_METHODS, { each: true })
  paymentMethods?: PromotionPaymentMethod[];

  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  weekdays?: number[];
  @IsOptional() @IsInt() @Min(0) @Max(24) hourFrom?: number;
  @IsOptional() @IsInt() @Min(0) @Max(24) hourTo?: number;
}

// ─── Program-level DTOs ───────────────────────────────────────────────────────

export class CreatePromotionDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;

  @IsDateString() startDate: string;
  @IsDateString() endDate: string;

  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() assignedToAll?: boolean;

  @IsOptional() @IsArray() @ArrayUnique() @IsMongoId({ each: true })
  assignedUsers?: string[];

  @IsOptional() @ValidateNested() @Type(() => PromotionConditionsDto)
  conditions?: PromotionConditionsDto;

  @IsOptional() @IsBoolean() exclusive?: boolean;
}

export class UpdatePromotionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() assignedToAll?: boolean;

  @IsOptional() @ValidateNested() @Type(() => PromotionConditionsDto)
  conditions?: PromotionConditionsDto;

  @IsOptional() @IsBoolean() exclusive?: boolean;
}

/** Add / remove users from a program */
export class AssignPromotionDto {
  @IsOptional() @IsBoolean() assignToAll?: boolean;

  @IsOptional() @IsArray() @ArrayUnique() @IsMongoId({ each: true })
  addUserIds?: string[];

  @IsOptional() @IsArray() @ArrayUnique() @IsMongoId({ each: true })
  removeUserIds?: string[];
}

// ─── Coupon-level DTOs ────────────────────────────────────────────────────────

export class CreateCouponItemDto {
  @IsString() code: string;

  @IsEnum(DiscountType) type: DiscountType;

  @IsNumber() @Min(0) value: number;

  @IsOptional() @IsNumber() @Min(0) minOrderValue?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscountAmount?: number;
  @IsOptional() @IsNumber() @Min(0) totalUsageLimit?: number;
  @IsOptional() @IsNumber() @Min(1) perUserUsageLimit?: number;
  @IsOptional() @IsBoolean() includeFreeShipping?: boolean;
  @IsOptional() @IsNumber() @Min(0) freeShippingMaxAmount?: number;
}

export class UpdateCouponItemDto {
  @IsOptional() @IsEnum(DiscountType) type?: DiscountType;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) minOrderValue?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscountAmount?: number;
  @IsOptional() @IsNumber() @Min(0) totalUsageLimit?: number;
  @IsOptional() @IsNumber() @Min(1) perUserUsageLimit?: number;
  @IsOptional() @IsBoolean() includeFreeShipping?: boolean;
  @IsOptional() @IsNumber() @Min(0) freeShippingMaxAmount?: number;
}

// ─── User-facing DTOs ─────────────────────────────────────────────────────────

/** Cart line for the checkout preview (product-scoped codes, "mua tối thiểu N sản phẩm"). */
export class ValidateCouponItemDto {
  @IsMongoId() productId: string;
  @IsInt() @Min(1) @Type(() => Number) quantity: number;
  /** Line subtotal shown in the cart (preview only — the order recomputes it from the catalog). */
  @IsNumber() @Min(0) @Type(() => Number) subtotal: number;
}

export class ValidateCouponsDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(50, { each: true })
  couponCodes: string[];

  @IsNumber() @Min(0) @Type(() => Number)
  orderTotal: number;

  /** Delivery province — the server derives the shipping fee from it to price free-shipping codes. */
  @IsOptional() @IsString() @MaxLength(200)
  city?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ValidateCouponItemDto)
  items?: ValidateCouponItemDto[];

  @IsOptional() @IsIn(PROMOTION_PAYMENT_METHODS)
  paymentMethod?: PromotionPaymentMethod;
}

export class QueryPromotionsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) isActive?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsNumber() @Min(1) @Type(() => Number) limit?: number;
}
