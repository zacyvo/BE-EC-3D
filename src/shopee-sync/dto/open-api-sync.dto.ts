import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsISO8601, IsOptional, IsString, Matches } from 'class-validator';

/** Product sync via Shopee Open API — same options as the extension flow, no extensionVersion. */
export class OpenApiProductSyncDto {
  /** SUPER_ADMIN only (checked in ShopeeOpenApiProductSyncService). */
  @IsOptional()
  @IsBoolean()
  forceFullSync?: boolean;
}

export class OpenApiManualProductSyncDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(/^\d+$/, { each: true, message: 'Product ID phải là dạng số' })
  productIds: string[];
}

/** Orders updated on Shopee within [from, to]. Defaults: last 7 days; max 90 days. */
export class OpenApiOrderSyncDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
