import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { ContractStatus, ContractTemplate, PaymentInfoType } from '../schemas/contract.schema';

/** Di động 10 số (0xxxxxxxxx) hoặc máy bàn 11 số có mã vùng (02xxxxxxxxx) */
const PHONE_REGEX = /^(0|\+84)\d{9,10}$/;

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

  /** Mẫu văn bản hợp đồng — mặc định DEFAULT */
  @IsOptional()
  @IsEnum(ContractTemplate)
  template?: ContractTemplate;

  /**
   * Điều 3.2 — lịch thanh toán; số đợt phải khớp template (kiểm tra ở service). Không truyền thì
   * lấy lịch mặc định của template.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Lịch thanh toán phải có ít nhất 1 đợt' })
  @ArrayMaxSize(5, { message: 'Lịch thanh toán tối đa 5 đợt' })
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

  /** Đổi mẫu văn bản — không kèm paymentSchedule thì lịch thanh toán reset về mặc định của template mới */
  @IsOptional()
  @IsEnum(ContractTemplate)
  template?: ContractTemplate;

  /** Điều 3.2 — lịch thanh toán; số đợt phải khớp template (kiểm tra ở service) */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Lịch thanh toán phải có ít nhất 1 đợt' })
  @ArrayMaxSize(5, { message: 'Lịch thanh toán tối đa 5 đợt' })
  @ValidateNested({ each: true })
  @Type(() => PaymentInstallmentDto)
  paymentSchedule?: PaymentInstallmentDto[];

  /** Điều 3.3 — bộ thông tin thanh toán: Công ty hoặc Cá nhân */
  @IsOptional()
  @IsEnum(PaymentInfoType)
  paymentInfoType?: PaymentInfoType;
}

// ── Admin — hợp đồng import từ file PDF ──────────────────────────────────────

/**
 * Metadata đi kèm file PDF khi import. Gửi dạng multipart: field `file` (PDF) + field `data`
 * (chuỗi JSON của DTO này) — controller tự parse và validate (xem AdminContractsController.import).
 */
export class ImportContractDto {
  @Matches(PHONE_REGEX, { message: 'Số điện thoại không hợp lệ' })
  userPhone: string;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập tên khách hàng / Bên A' })
  @MaxLength(200)
  customerName: string;

  /** Số hợp đồng in trên file PDF — để trống hệ thống tự sinh */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contractNo?: string;

  @IsOptional() @IsString() @MaxLength(200) title?: string;

  @IsNumber({}, { message: 'Giá trị hợp đồng không hợp lệ' })
  @Min(0)
  totalAmount: number;

  /** Giá vốn — dùng khi ghi nhận tài chính lúc Hoàn tất */
  @IsOptional() @IsNumber() @Min(0) costAmount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyA?: ContractPartyDto;

  @IsOptional() @IsDateString() signDate?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string;

  /** File đã được hai bên ký ngoài hệ thống (ký tay / bản scan) */
  @IsOptional() @IsBoolean() offlineSigned?: boolean;
}

/** Sửa metadata hợp đồng import — nội dung văn bản nằm trong file PDF, thay bằng endpoint thay file */
export class UpdateImportedContractDto {
  @IsOptional() @IsString() @MaxLength(50) contractNo?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsNumber() @Min(0) totalAmount?: number;
  @IsOptional() @IsNumber() @Min(0) costAmount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractPartyDto)
  partyA?: ContractPartyDto;

  @IsOptional() @IsDateString() signDate?: string;
  @IsOptional() @IsDateString() deliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string;
  @IsOptional() @IsBoolean() offlineSigned?: boolean;
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
