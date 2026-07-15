import { IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

/** Client only supplies the old district/ward codes; the server resolves
 * the canonical old + new address from AddressConversionService. */
export class OldAddressInputDto {
  @Type(() => Number) @IsInt() districtCode: number;
  @IsOptional() @Type(() => Number) @IsInt() wardCode?: number;
}
