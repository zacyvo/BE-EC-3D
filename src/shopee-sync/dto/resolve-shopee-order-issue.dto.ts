import { IsArray, IsInt, IsMongoId, IsOptional, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ShopeeOrderIssueItemMappingDto {
  @IsInt() @Min(0) index: number;
  @IsMongoId() productId: string;
}

/** Body for POST .../issues/:id/resolve. Line items that already auto-matched
 * confidently don't need an entry here — only override the ones that need a
 * staff-picked product. */
export class ResolveShopeeOrderIssueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShopeeOrderIssueItemMappingDto)
  itemMappings?: ShopeeOrderIssueItemMappingDto[];
}
