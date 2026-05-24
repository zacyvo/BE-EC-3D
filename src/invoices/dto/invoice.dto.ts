import {
  IsEnum, IsInt, IsNumber, IsOptional, IsString,
  MaxLength, Min, IsArray, IsDateString,
} from 'class-validator';
import { InvoiceCategory, InvoiceSource } from '../schemas/invoice.schema';

export class CreateInvoiceDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsEnum(InvoiceCategory)
  category: InvoiceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customCategory?: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsEnum(InvoiceSource)
  source: InvoiceSource;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customSource?: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}

export class UpdateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsEnum(InvoiceCategory)
  category?: InvoiceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customCategory?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsEnum(InvoiceSource)
  source?: InvoiceSource;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customSource?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}
