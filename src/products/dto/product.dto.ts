import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  IsEnum,
  Min,
  Max,
  MaxLength,
  MinLength,
  IsMongoId,
  ValidateNested,
  Matches,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SocialPlatform } from '../schemas/product.schema';

export class ProductColorDto {
  @IsString() @MinLength(1) @MaxLength(50) name: string;

  @IsOptional()
  @IsString()
  @Matches(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, { message: 'hexCode must be a valid hex color, e.g. #FF0000' })
  hexCode?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}

/** Price for one color/size combination. finalPrice is computed server-side. */
export class ProductVariantPriceDto {
  @IsOptional() @IsString() @MaxLength(50) color?: string;
  @IsOptional() @IsString() @MaxLength(50) size?: string;
  @IsNumber() @Min(0) sellingPrice: number;
  @IsOptional() @IsString() @MaxLength(100) sku?: string;
}

export class ProductSocialDto {
  @IsEnum(SocialPlatform) name: SocialPlatform;
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() link?: string;
}

export class CreateProductDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsMongoId() category: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional() @IsString() @MaxLength(2000) video?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductColorDto)
  colors?: ProductColorDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sizes?: string[];

  /** Per color/size prices; entries not matching the current colors/sizes are dropped. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantPriceDto)
  variants?: ProductVariantPriceDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSocialDto)
  socials?: ProductSocialDto[];

  @IsNumber() @Min(0) costPrice: number;
  @IsNumber() @Min(0) sellingPrice: number;
  @IsNumber() @Min(0) @Max(100) @IsOptional() discountPercent?: number;
  @IsNumber() @Min(0) stock: number;

  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() eta?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsMongoId() category?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) images?: string[];
  @IsOptional() @IsString() @MaxLength(2000) video?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductColorDto)
  colors?: ProductColorDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sizes?: string[];

  /** Per color/size prices; entries not matching the current colors/sizes are dropped. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantPriceDto)
  variants?: ProductVariantPriceDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSocialDto)
  socials?: ProductSocialDto[];

  @IsOptional() @IsNumber() @Min(0) costPrice?: number;
  @IsOptional() @IsNumber() @Min(0) sellingPrice?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) stock?: number;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() eta?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
