import { Type } from 'class-transformer';
import {
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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContractStatus } from '../schemas/contract.schema';

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
