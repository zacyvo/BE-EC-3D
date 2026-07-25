import {
  IsString, IsNotEmpty, IsOptional, IsInt, Min, IsEnum, IsDateString, IsMongoId,
  MaxLength,
} from 'class-validator';
import { PrintPlanStatus } from '../schemas/print-plan.schema';

export class CreatePrintPlanDto {
  @IsMongoId({ message: 'Sản phẩm không hợp lệ' })
  @IsOptional()
  productId?: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @MaxLength(200)
  productName: string;

  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @Min(1, { message: 'Số lượng phải lớn hơn 0' })
  quantity: number;

  @IsDateString({}, { message: 'Ngày giao không hợp lệ' })
  deliveryDate: string;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng chọn nguồn đơn hàng' })
  @MaxLength(100)
  source: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000, { message: 'Ghi chú không quá 2000 ký tự' })
  note?: string;
}

export class UpdatePrintPlanDto {
  @IsMongoId({ message: 'Sản phẩm không hợp lệ' })
  @IsOptional()
  productId?: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @MaxLength(200)
  @IsOptional()
  productName?: string;

  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @Min(1, { message: 'Số lượng phải lớn hơn 0' })
  @IsOptional()
  quantity?: number;

  @IsDateString({}, { message: 'Ngày giao không hợp lệ' })
  @IsOptional()
  deliveryDate?: string;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng chọn nguồn đơn hàng' })
  @MaxLength(100)
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000, { message: 'Ghi chú không quá 2000 ký tự' })
  note?: string;
}

export class UpdatePrintPlanStatusDto {
  @IsEnum(PrintPlanStatus, { message: 'Trạng thái không hợp lệ' })
  status: PrintPlanStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  errorReason?: string;
}
