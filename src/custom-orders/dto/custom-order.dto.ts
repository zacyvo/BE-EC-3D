import {
  IsString, IsNotEmpty, IsArray, ArrayMaxSize, IsEmail,
  IsOptional, IsEnum, MaxLength, MinLength,
} from 'class-validator';
import { CustomOrderStatus } from '../schemas/custom-order.schema';

export class CreateCustomOrderDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'Nội dung phải có ít nhất 10 ký tự' })
  @MaxLength(2000, { message: 'Nội dung không quá 2000 ký tự' })
  content: string;

  @IsArray()
  @ArrayMaxSize(3, { message: 'Tối đa 3 ảnh' })
  @IsString({ each: true })
  @IsOptional()
  images?: string[];

  @IsString()
  @IsNotEmpty()
  contactName: string;

  @IsString()
  @IsNotEmpty()
  contactPhone: string;

  @IsEmail({}, { message: 'Email không hợp lệ' })
  contactEmail: string;
}

export class UpdateCustomOrderStatusDto {
  @IsEnum(CustomOrderStatus)
  status: CustomOrderStatus;

  @IsString()
  @IsOptional()
  adminNote?: string;

  @IsString()
  @IsOptional()
  cancelReason?: string;
}
