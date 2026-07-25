import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { EInvoiceKind } from '../schemas/einvoice.schema';

/** Thuế suất hợp lệ — xem Phụ lục VII.3 tài liệu tích hợp (bỏ qua -5 thuê tài chính, ít dùng) */
export const ALLOWED_VAT_RATES = [0, 5, 8, 10, -1, -2, -3] as const;

export class EInvoiceItemDto {
  @IsOptional() @IsString() @MaxLength(50)
  code?: string;

  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập tên sản phẩm/dịch vụ' }) @MaxLength(500)
  name: string;

  @IsOptional() @IsString() @MaxLength(50)
  unit?: string;

  @IsNumber() @Min(0.0001, { message: 'Số lượng phải lớn hơn 0' })
  quantity: number;

  @IsNumber() @Min(0)
  unitPrice: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  discountPercent?: number;

  @IsOptional() @IsNumber() @Min(0)
  discountAmount?: number;

  @IsIn(ALLOWED_VAT_RATES, { message: 'Thuế suất không hợp lệ' })
  vatRate: number;

  @IsOptional() @IsNumber()
  vatRateOther?: number;

  @IsOptional() @IsInt() @Min(1) @Max(5)
  feature?: number;
}

export class CreateEInvoiceDto {
  /** Loại hoá đơn — mặc định TAX_AUTHORITY nếu không truyền (hoá đơn điện tử hợp lệ qua EasyInvoice) */
  @IsOptional() @IsEnum(EInvoiceKind)
  invoiceKind?: EInvoiceKind;

  /** Đơn hàng nguồn (tuỳ chọn) — dùng để điền trước thông tin người mua/sản phẩm */
  @IsOptional() @IsMongoId()
  orderId?: string;

  /** Hợp đồng liên kết (tuỳ chọn) — khi có, hoá đơn dùng CHUNG khoá bảo mật của hợp đồng */
  @IsOptional() @IsMongoId()
  contractId?: string;

  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập tên người mua hàng' }) @MaxLength(200)
  buyerName: string;

  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập tên khách hàng/đơn vị' }) @MaxLength(200)
  customerName: string;

  @IsOptional() @IsString() @MaxLength(50)
  customerTaxCode?: string;

  @IsOptional() @IsString() @MaxLength(300)
  customerAddress?: string;

  @IsOptional() @IsString() @MaxLength(20)
  customerPhone?: string;

  @IsOptional() @IsEmail()
  customerEmail?: string;

  @IsString() @IsNotEmpty({ message: 'Vui lòng chọn hình thức thanh toán' }) @MaxLength(100)
  paymentMethod: string;

  @IsOptional() @IsString() @MaxLength(10)
  currencyUnit?: string;

  @IsOptional() @IsDateString()
  arisingDate?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  @IsArray() @ArrayMinSize(1, { message: 'Hoá đơn cần ít nhất 1 sản phẩm/dịch vụ' })
  @ValidateNested({ each: true })
  @Type(() => EInvoiceItemDto)
  items: EInvoiceItemDto[];
}

export class CancelEInvoiceDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class RevealKeyDto {
  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu để xác thực' })
  password: string;
}

export class VerifyEInvoiceDto {
  @IsString() @IsNotEmpty({ message: 'Vui lòng nhập khoá mở hoá đơn' }) @MaxLength(20)
  securityCode: string;
}
