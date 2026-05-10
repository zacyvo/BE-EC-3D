import {
  IsString, IsEnum, IsNumber, IsOptional, IsBoolean,
  IsDateString, IsArray, IsMongoId, Min, Max, ArrayUnique,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DiscountType } from '../schemas/promotion.schema';

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
}

export class UpdatePromotionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() assignedToAll?: boolean;
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
}

export class UpdateCouponItemDto {
  @IsOptional() @IsEnum(DiscountType) type?: DiscountType;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) minOrderValue?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscountAmount?: number;
  @IsOptional() @IsNumber() @Min(0) totalUsageLimit?: number;
  @IsOptional() @IsNumber() @Min(1) perUserUsageLimit?: number;
}

// ─── User-facing DTOs ─────────────────────────────────────────────────────────

export class ValidateCouponsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true })
  couponCodes: string[];

  @IsNumber() @Min(0) @Type(() => Number)
  orderTotal: number;
}

export class QueryPromotionsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) isActive?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsNumber() @Min(1) @Type(() => Number) limit?: number;
}
