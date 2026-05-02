import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  MinLength,
  ArrayMinSize,
  IsMongoId,
} from 'class-validator';

export class CreateProductDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsMongoId() category: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least 1 image required' })
  @IsString({ each: true })
  images: string[];

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
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsString({ each: true }) images?: string[];
  @IsOptional() @IsNumber() @Min(0) costPrice?: number;
  @IsOptional() @IsNumber() @Min(0) sellingPrice?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) stock?: number;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() eta?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
