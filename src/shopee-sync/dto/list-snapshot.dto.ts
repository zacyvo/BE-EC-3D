import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';

/** One row of the Shopee List Product index — no pricing/stock/images here, those
 * only arrive later via the per-product Detail upload. Deliberately excludes any
 * Shopee session field (SPC_CDS etc.) — the global ValidationPipe's
 * `forbidNonWhitelisted` rejects the whole request if the extension ever included one.
 *
 * `externalProductId` is a STRING end-to-end (never parsed as a number) — matches the
 * feature spec's explicit `String(product.id)` dedupe rule and avoids any risk of
 * precision loss on very large Shopee ids. */
export class ProductIndexItemDto {
  @IsString()
  @IsNotEmpty()
  externalProductId: string;

  @IsInt()
  @Min(0)
  modifyTime: number;

  @IsInt()
  @Min(0)
  createTime: number;

  @IsInt()
  status: number;
}

export class ListSnapshotDto {
  @IsInt()
  @Min(0)
  total: number;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => ProductIndexItemDto)
  items: ProductIndexItemDto[];
}
