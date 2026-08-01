import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MarketplaceImageType } from '../schemas/marketplace-product-image.schema';

/** Decimal-string price/measurement fields — validated as a plain non-negative
 * decimal string (never `IsNumber`) to avoid float rounding on Shopee's raw values;
 * the DB and the diff engine treat prices as strings/`Number()`-on-demand only for
 * comparisons, never re-serialize a parsed float back to storage. */
const DECIMAL_STRING_REGEX = /^\d+(\.\d+)?$/;

export class MarketplaceDimensionDto {
  @IsOptional() @IsString() width?: string | null;
  @IsOptional() @IsString() length?: string | null;
  @IsOptional() @IsString() height?: string | null;
}

export class TierVariationUploadDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name: string;

  @IsArray() @IsString({ each: true })
  options: string[];
}

export class MarketplaceImageUploadDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  sourceImageId: string;

  @IsString() @IsNotEmpty() @MaxLength(2000)
  sourceUrl: string;

  @IsEnum(MarketplaceImageType)
  imageType: MarketplaceImageType;

  @IsInt() @Min(0)
  position: number;
}

export class MarketplaceVariantUploadDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  externalVariantId: string;

  /** null for Shopee's synthetic default model (`{ is_default: true, name: "" }`) — kept, not dropped. */
  @IsOptional() @IsString() @MaxLength(500)
  name?: string | null;

  @IsBoolean()
  isDefault: boolean;

  @IsOptional() @IsString() @MaxLength(200)
  sku?: string | null;

  @IsArray()
  @IsInt({ each: true })
  tierIndexes: number[];

  @IsOptional() @IsString() @MaxLength(200)
  imageId?: string | null;

  @IsOptional() @IsString() @MaxLength(2000)
  imageUrl?: string | null;

  @Matches(DECIMAL_STRING_REGEX, { message: 'normalPrice phải là chuỗi số thập phân không âm' })
  normalPrice: string;

  @Matches(DECIMAL_STRING_REGEX, { message: 'promotionPrice phải là chuỗi số thập phân không âm' })
  promotionPrice: string;

  /** Recomputed server-side from normalPrice/promotionPrice — see ShopeeSyncDiffService.
   * Accepted here too only so the DTO shape matches the normalized schema 1:1. */
  @Matches(DECIMAL_STRING_REGEX, { message: 'effectivePrice phải là chuỗi số thập phân không âm' })
  effectivePrice: string;

  @IsInt() @Min(0) availableStock: number;
  @IsInt() @Min(0) sellerStock: number;
  @IsInt() @Min(0) shopeeStock: number;
  @IsInt() @Min(0) reservedStock: number;

  @IsOptional() @IsInt() @Min(0)
  soldCount?: number | null;

  @IsOptional() @IsInt()
  availableStatus?: number | null;

  @IsBoolean()
  preOrder: boolean;

  @IsOptional() @IsInt() @Min(0)
  daysToShip?: number | null;
}

export class MarketplaceProductUploadDto {
  /** Only Shopee today — validated (not just documented) so a future adapter can't silently
   * upload under the wrong channel label. */
  @IsIn(['SHOPEE'])
  source: 'SHOPEE';

  /** Must equal the `:productId` route param — checked in the service (SHOPEE_PRODUCT_ID_MISMATCH). */
  @IsString() @IsNotEmpty()
  externalProductId: string;

  @IsString() @IsNotEmpty() @MaxLength(500)
  name: string;

  @IsInt()
  rawStatus: number;

  @IsOptional() @IsString() @MaxLength(200)
  parentSku?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  coverImageId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarketplaceImageUploadDto)
  images: MarketplaceImageUploadDto[];

  @IsOptional() @IsString() @MaxLength(50_000)
  description?: string | null;

  @IsOptional() @IsString() @MaxLength(50)
  descriptionType?: string | null;

  @IsArray() @IsInt({ each: true })
  categoryIds: number[];

  @IsArray() @IsString({ each: true })
  categoryNames: string[];

  @IsOptional() @IsInt()
  condition?: number | null;

  @IsOptional() @IsString() @MaxLength(200)
  brandId?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  brandName?: string | null;

  @Matches(DECIMAL_STRING_REGEX) priceMin: string;
  @Matches(DECIMAL_STRING_REGEX) priceMax: string;
  @Matches(DECIMAL_STRING_REGEX) sellingPriceMin: string;
  @Matches(DECIMAL_STRING_REGEX) sellingPriceMax: string;

  @IsInt() @Min(0) availableStock: number;
  @IsInt() @Min(0) sellerStock: number;
  @IsInt() @Min(0) shopeeStock: number;

  @IsInt() @Min(0) soldCount: number;
  @IsInt() @Min(0) viewCount: number;
  @IsInt() @Min(0) likedCount: number;

  @IsOptional() @IsString() @MaxLength(50)
  weightValue?: string | null;

  @IsOptional() @IsNumber()
  weightUnit?: number | null;

  @ValidateNested()
  @Type(() => MarketplaceDimensionDto)
  dimension: MarketplaceDimensionDto;

  /** Shopee variation dimensions (e.g. "Màu sắc"/"Kích thước") — used only to publish
   * colors/sizes to the real catalog; empty for products with no variation. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierVariationUploadDto)
  tierVariations?: TierVariationUploadDto[];

  @IsBoolean()
  preOrder: boolean;

  @IsOptional() @IsInt() @Min(0)
  daysToShip?: number | null;

  @IsInt() @Min(0)
  sourceCreatedAt: number;

  @IsInt() @Min(0)
  sourceModifiedAt: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'Sản phẩm phải có ít nhất 1 model (kể cả model mặc định)' })
  @ValidateNested({ each: true })
  @Type(() => MarketplaceVariantUploadDto)
  variants: MarketplaceVariantUploadDto[];
}

/**
 * Body of `POST .../products/:productId`. Either a successful normalized payload
 * (`product` set) or a per-product failure report (`failed: true`) — the extension
 * uses the latter so one bad product doesn't abort the whole sync (see
 * feature spec section 16, "Schema changed" / per-product HTTP errors).
 */
export class UploadProductDetailDto {
  @IsOptional()
  @IsBoolean()
  failed?: boolean;

  @IsOptional() @IsString() @MaxLength(60)
  errorCode?: string;

  @IsOptional() @IsString() @MaxLength(500)
  errorMessage?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarketplaceProductUploadDto)
  product?: MarketplaceProductUploadDto;
}
