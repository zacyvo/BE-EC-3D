import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SOCIAL_ICON_KEYS, SocialIconKey } from '../constants/social-icons.constant';

const VN_PHONE = /^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/;
const PASSWORD_COMPLEXITY = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

// ─── Admin ──────────────────────────────────────────────────────────────────

export class AdminCreateNfcDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nfcId?: string;
}

export class SocialLinkDto {
  @IsIn(SOCIAL_ICON_KEYS)
  icon: SocialIconKey;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  value: string;
}

export class SaveSocialLinksDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  links: SocialLinkDto[];
}

// ─── Public ─────────────────────────────────────────────────────────────────

export class PublicActivateDto {
  @IsString()
  @Matches(VN_PHONE, { message: 'Số điện thoại không hợp lệ (VD: 0912345678)' })
  phone: string;

  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @Matches(PASSWORD_COMPLEXITY, { message: 'Mật khẩu cần có chữ hoa, chữ thường và số' })
  password: string;

  @IsString()
  confirmPassword: string;

  @IsBoolean()
  @Equals(true, { message: 'Bạn cần đồng ý điều khoản sử dụng' })
  agreeTerms: boolean;
}

export class PublicLoginDto {
  @IsString()
  phone: string;

  @IsString()
  password: string;
}
