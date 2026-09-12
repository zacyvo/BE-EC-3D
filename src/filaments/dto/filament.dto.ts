import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional,
  IsString, Min, ValidateNested, ArrayMinSize, MaxLength,
} from 'class-validator';
import { FilamentColor, FilamentType, FilamentUnitStatus } from '../schemas/filament.schema';

export class FilamentImportItemDto {
  @IsEnum(FilamentType)
  type: FilamentType;

  @IsEnum(FilamentColor)
  color: FilamentColor;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Giá nhập / cuộn — nếu bỏ trống, bắt buộc điền `totalAmount` ở phiếu để tính giá trung bình. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;
}

export class CreateFilamentImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilamentImportItemDto)
  items: FilamentImportItemDto[];

  /** Giá tổng hóa đơn — bắt buộc nếu có ít nhất 1 loại chưa điền giá nhập riêng. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ExportFilamentDto {
  @IsEnum(FilamentType)
  type: FilamentType;

  @IsEnum(FilamentColor)
  color: FilamentColor;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Kiểm kê — đối chiếu số lượng thực đếm với hệ thống cho 1 tổ hợp loại/màu/trạng thái. */
export class AdjustFilamentStockDto {
  @IsEnum(FilamentType)
  type: FilamentType;

  @IsEnum(FilamentColor)
  color: FilamentColor;

  @IsEnum(FilamentUnitStatus)
  status: FilamentUnitStatus;

  /** Số lượng đếm được thực tế — hệ thống sẽ tự thêm/bớt cho khớp số này. */
  @IsInt()
  @Min(0)
  actualQuantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
