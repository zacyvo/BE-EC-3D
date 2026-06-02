import {
  IsArray, IsNotEmpty, IsNumber, IsOptional,
  IsString, Min, ValidateNested, ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExportItemDto {
  @IsString() @IsNotEmpty() productId: string;
  @IsString() @IsNotEmpty() productCode: string;
  @IsString() @IsNotEmpty() productName: string;
  @IsNumber() @Min(1) quantity: number;
  @IsNumber() @Min(0) shippingPrice: number;
  @IsNumber() @Min(0) costPrice: number;
}

export class CreateWarehouseExportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExportItemDto)
  items: ExportItemDto[];

  @IsString() @IsNotEmpty() recipientName: string;
  @IsOptional() @IsString() recipientPhone?: string;
  @IsOptional() @IsString() recipientAddress?: string;

  @IsOptional() @IsString() note?: string;
}
