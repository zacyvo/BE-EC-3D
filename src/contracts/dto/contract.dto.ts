import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContractStatus, PaymentInfoType } from '../schemas/contract.schema';

const PHONE_REGEX = /^(0|\+84)\d{9}$/;

// ── Shared ────────────────────────────────────────────────────────────────────

export class ContractItemDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Đơn giá thoả thuận trong hợp đồng — mặc định lấy finalPrice của sản phẩm */
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;
}

export class ContractPartyDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(120) representative?: string;
  @IsOptional() @IsString() @MaxLength(120) position?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(50) taxCode?: string;
}

/** Điều 3.2 — một đợt thanh toán */
export class PaymentInstallmentDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  percent: number;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập mốc thời gian thanh toán' })
  @MaxLength(200)
  timing: string;
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export class CreateContractDto {
  @Matches(PHONE_REGEX, { message: 'Số điện thoại không hợp lệ' })
  userPhone: string;

  /** Tên khách hàng — dùng khi SĐT chưa có tài khoản (tạo guest) */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Hợp đồng phải có ít nhất 1 sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => ContractItemDto)
  items: ContractItemDto[];

  @IsOptional() @IsString() @MaxLength(200) signPlace?: string;
  @IsOptional() @IsString() @MaxLength(2000) technicalRequirements?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string;

  /** Điều 3.2 — lịch thanh toán 3 đợt (mặc định 50/40/10 nếu không truyền) */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3, { message: 'Lịch thanh toán phải có đúng 3 đợt' })
  @ArrayMaxSize(3, { message: 'Lịch thanh toán phải có đúng 3 đợt' })
  @ValidateNested({ each: true })
  @Type(() => PaymentInstallmentDto)
  paymentSchedule?: PaymentInstallmentDto[];

  /** Điều 3.3 — bộ thông tin thanh toán: Công ty (mặc định) hoặc Cá nhân */
  @IsOptional()
  @IsEnum(PaymentInfoType)
  paymentInfoType?: PaymentInfoType;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyB?: ContractPartyDto;
}

export class UpdateContractDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Hợp đồng phải có ít nhất 1 sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => ContractItemDto)
  items?: ContractItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyA?: ContractPartyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyB?: ContractPartyDto;

  @IsOptional() @IsString() @MaxLength(200) signPlace?: string;
  @IsOptional() @IsDateString() signDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) technicalRequirements?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(300) deliveryAddress?: string;
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string;

  /** Điều 3.2 — lịch thanh toán 3 đợt */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3, { message: 'Lịch thanh toán phải có đúng 3 đợt' })
  @ArrayMaxSize(3, { message: 'Lịch thanh toán phải có đúng 3 đợt' })
  @ValidateNested({ each: true })
  @Type(() => PaymentInstallmentDto)
  paymentSchedule?: PaymentInstallmentDto[];

  /** Điều 3.3 — bộ thông tin thanh toán: Công ty hoặc Cá nhân */
  @IsOptional()
  @IsEnum(PaymentInfoType)
  paymentInfoType?: PaymentInfoType;
}

export class UpdateContractStatusDto {
  @IsEnum(ContractStatus)
  status: ContractStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RevealCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  password: string;
}

export class RejectSignatureDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập lý do từ chối' })
  @MaxLength(500)
  reason: string;
}

// ── Public (user qua link bảo mật) ───────────────────────────────────────────

export class PublicVerifyDto {
  @Matches(PHONE_REGEX, { message: 'Số điện thoại không hợp lệ' })
  phone: string;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập mã bảo mật' })
  @MaxLength(16)
  securityCode: string;
}

export class PublicUpdateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyA?: ContractPartyDto;

  @IsOptional() @IsString() @MaxLength(300) deliveryAddress?: string;
  @IsOptional() @IsString() @MaxLength(2000) userNote?: string;
}

/** Chữ ký điện tử đơn giản (canvas) — fallback khi khách không có chữ ký số thật */
export class SubmitSimpleSignatureDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng ký trước khi xác nhận' })
  canvasImageBase64: string;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập họ tên xác nhận' })
  @MaxLength(120)
  confirmedName: string;
}
