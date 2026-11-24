import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDate, IsEnum, IsInt, IsMongoId,
  IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, Min, ValidateIf,
} from 'class-validator';
import { BannerLinkType, BannerPlacement } from '../banner.constants';

export class CreateBannerDto {
  @IsEnum(BannerPlacement, { message: 'Vị trí banner không hợp lệ' })
  placement: BannerPlacement;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập tên banner' })
  @MaxLength(120, { message: 'Tên banner tối đa 120 ký tự' })
  title: string;

  @IsString()
  @MaxLength(200, { message: 'Mô tả ảnh tối đa 200 ký tự' })
  @IsOptional()
  altText?: string;

  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }, { message: 'Ảnh desktop không hợp lệ' })
  imageDesktop: string;

  @ValidateIf((o) => !!o.imageMobile)
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }, { message: 'Ảnh mobile không hợp lệ' })
  @IsOptional()
  imageMobile?: string;

  @IsEnum(BannerLinkType, { message: 'Loại liên kết không hợp lệ' })
  linkType: BannerLinkType;

  /** Kiểm tra theo linkType trong BannersService (INTERNAL cần "/...", EXTERNAL cần http(s)/tel/mailto). */
  @IsString()
  @MaxLength(1000, { message: 'Liên kết tối đa 1000 ký tự' })
  @IsOptional()
  linkUrl?: string;

  @ValidateIf((o) => o.linkType === BannerLinkType.PRODUCT)
  @IsMongoId({ message: 'Vui lòng chọn sản phẩm liên kết' })
  productId?: string | null;

  @IsBoolean()
  @IsOptional()
  openInNewTab?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ValidateIf((o) => o.startAt !== null && o.startAt !== undefined)
  @Type(() => Date)
  @IsDate({ message: 'Thời gian bắt đầu không hợp lệ' })
  startAt?: Date | null;

  @ValidateIf((o) => o.endAt !== null && o.endAt !== undefined)
  @Type(() => Date)
  @IsDate({ message: 'Thời gian kết thúc không hợp lệ' })
  endAt?: Date | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class UpdateBannerDto {
  @IsEnum(BannerPlacement, { message: 'Vị trí banner không hợp lệ' })
  @IsOptional()
  placement?: BannerPlacement;

  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập tên banner' })
  @MaxLength(120, { message: 'Tên banner tối đa 120 ký tự' })
  @IsOptional()
  title?: string;

  @IsString()
  @MaxLength(200, { message: 'Mô tả ảnh tối đa 200 ký tự' })
  @IsOptional()
  altText?: string;

  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }, { message: 'Ảnh desktop không hợp lệ' })
  @IsOptional()
  imageDesktop?: string;

  @ValidateIf((o) => !!o.imageMobile)
  @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }, { message: 'Ảnh mobile không hợp lệ' })
  @IsOptional()
  imageMobile?: string;

  @IsEnum(BannerLinkType, { message: 'Loại liên kết không hợp lệ' })
  @IsOptional()
  linkType?: BannerLinkType;

  @IsString()
  @MaxLength(1000, { message: 'Liên kết tối đa 1000 ký tự' })
  @IsOptional()
  linkUrl?: string;

  @ValidateIf((o) => o.productId !== null && o.productId !== undefined)
  @IsMongoId({ message: 'Vui lòng chọn sản phẩm liên kết' })
  productId?: string | null;

  @IsBoolean()
  @IsOptional()
  openInNewTab?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ValidateIf((o) => o.startAt !== null && o.startAt !== undefined)
  @Type(() => Date)
  @IsDate({ message: 'Thời gian bắt đầu không hợp lệ' })
  startAt?: Date | null;

  @ValidateIf((o) => o.endAt !== null && o.endAt !== undefined)
  @Type(() => Date)
  @IsDate({ message: 'Thời gian kết thúc không hợp lệ' })
  endAt?: Date | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class ReorderBannersDto {
  @IsEnum(BannerPlacement, { message: 'Vị trí banner không hợp lệ' })
  placement: BannerPlacement;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  ids: string[];
}

export class PublicBannersQueryDto {
  @IsEnum(BannerPlacement, { message: 'Vị trí banner không hợp lệ' })
  @IsOptional()
  placement?: BannerPlacement;
}
