import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateSyncSessionDto {
  /** Reported by the extension via the Admin page's "ping" round-trip before sync starts. */
  @IsString()
  @MaxLength(30)
  extensionVersion: string;

  /** Restricted to SUPER_ADMIN at the controller level — see AdminIntegrationsShopeeController. */
  @IsOptional()
  @IsBoolean()
  forceFullSync?: boolean;
}

/** "Đồng bộ theo Product ID" — admin supplies exact Shopee product_id(s), no List phase. */
export class CreateManualSyncSessionDto {
  @IsString()
  @MaxLength(30)
  extensionVersion: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^\d+$/, { each: true, message: 'Product ID phải là dạng số' })
  productIds: string[];
}

