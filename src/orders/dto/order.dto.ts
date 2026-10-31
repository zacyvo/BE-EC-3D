import {
  IsString,
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  ValidateNested,
  ValidateIf,
  ArrayMinSize,
  Min,
  Max,
  IsEnum,
  IsDateString,
  Matches,
  ArrayUnique,
  MaxLength,
  IsEmail,
  IsNotEmpty,
  ValidateBy,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { EInvoiceBuyerType, OrderStatus } from '../schemas/order.schema';
import { OldAddressInputDto } from '../../locations/dto/old-address-input.dto';

/** Shared with shopee-order-mapping.util.ts (masked/invalid Shopee phone detection) —
 * keep both in sync if this ever changes. */
export const VN_MOBILE_REGEX = /^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/;

export class OrderItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) quantity: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
}

export class ShippingInfoDto {
  @IsString() recipientName: string;
  @IsString()
  @Matches(VN_MOBILE_REGEX, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone: string;
  @IsString() street: string;
  @ValidateIf((o) => !o.oldAddress) @IsString() ward: string;
  @IsOptional() @IsString() district?: string;
  @ValidateIf((o) => !o.oldAddress) @IsString() city: string;
  @IsOptional() @IsString() note?: string;

  /** Old (pre-2025-merger) address selection. When present, the server resolves
   * and overwrites ward/city — the client's ward/city values above are ignored. */
  @IsOptional() @ValidateNested() @Type(() => OldAddressInputDto) oldAddress?: OldAddressInputDto;
}

/** Mã số thuế doanh nghiệp: 10 số, hoặc 10 số + "-" + 3 số (chi nhánh). */
export const COMPANY_TAX_CODE_REGEX = /^\d{10}(-\d{3})?$/;
/** Cá nhân: MST 10 số hoặc số định danh (CCCD) 12 số. */
export const PERSONAL_TAX_CODE_REGEX = /^(\d{10}|\d{12})$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Required + company format for COMPANY; optional + personal format for INDIVIDUAL. */
function IsTaxCodeForBuyerType() {
  const isCompany = (o: object) => (o as EInvoiceRequestDto).buyerType === EInvoiceBuyerType.COMPANY;
  return ValidateBy({
    name: 'isTaxCodeForBuyerType',
    validator: {
      validate: (value, args) => {
        if (isCompany(args!.object)) return typeof value === 'string' && COMPANY_TAX_CODE_REGEX.test(value);
        return value === undefined || value === '' || (typeof value === 'string' && PERSONAL_TAX_CODE_REGEX.test(value));
      },
      defaultMessage: (args) =>
        isCompany(args!.object)
          ? 'Mã số thuế công ty không hợp lệ (10 số, chi nhánh: 10 số-3 số)'
          : 'Mã số thuế/CCCD không hợp lệ (10 hoặc 12 số)',
    },
  });
}

/** Buyer details for a VAT e-invoice — at checkout or later from the order page. */
export class EInvoiceRequestDto {
  @IsEnum(EInvoiceBuyerType, { message: 'Vui lòng chọn loại người mua (cá nhân/công ty)' })
  buyerType: EInvoiceBuyerType;

  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập họ tên người mua hàng' }) @MaxLength(200)
  buyerName: string;

  @ValidateIf((o) => o.buyerType === EInvoiceBuyerType.COMPANY)
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập tên công ty/đơn vị' }) @MaxLength(200)
  companyName?: string;

  @Transform(trim) @IsTaxCodeForBuyerType()
  taxCode?: string;

  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ xuất hoá đơn' }) @MaxLength(300)
  address: string;

  @Transform(trim) @IsEmail({}, { message: 'Email nhận hoá đơn không hợp lệ' }) @MaxLength(200)
  email: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(20)
  phone?: string;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => ShippingInfoDto)
  shippingInfo: ShippingInfoDto;

  @IsOptional() @IsString() customerNote?: string;

  /** Coupon codes to apply to this order */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  couponCodes?: string[];

  /** Customer asks for a VAT e-invoice — adds EINVOICE_VAT_RATE % to the total, shop approves. */
  @IsOptional() @ValidateNested() @Type(() => EInvoiceRequestDto)
  einvoiceRequest?: EInvoiceRequestDto;
}

export class RejectEInvoiceRequestDto {
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập lý do từ chối' }) @MaxLength(500)
  reason: string;
}

export class DeliveryDto {
  @IsOptional() @IsString() carrierName?: string;
  @IsOptional() @IsString() trackingCode?: string;
  @IsOptional() @IsString() trackingUrl?: string;
  @IsOptional() @IsDateString() estimatedDeliveryDate?: string;
  @IsOptional() @IsNumber() @Min(0) insuranceAmount?: number;
  @IsOptional() @IsNumber() @Min(0) codAmount?: number;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() csNote?: string;
  @IsOptional() @IsString() cancelReason?: string;
  @IsOptional() @ValidateNested() @Type(() => DeliveryDto) delivery?: DeliveryDto;
  @IsOptional() @IsNumber() @Min(0) paidAmount?: number;
}

/** Customer cancel / cancel request — the reason is optional free text. */
export class UserCancelOrderDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class GuestInfoDto {
  @IsString()
  @Matches(VN_MOBILE_REGEX, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone: string;

  @IsString() name: string;
}

export class AdminDirectDiscountDto {
  /** 'AMOUNT' = fixed VND amount, 'PERCENT' = percentage off */
  @IsEnum(['AMOUNT', 'PERCENT']) type: 'AMOUNT' | 'PERCENT';

  /** For AMOUNT: VND value. For PERCENT: 0–100. */
  @IsNumber() @Min(0) value: number;

  @IsOptional() @IsString() reason?: string;
}

export class AdminCreateOrderDto {
  /** ID of an existing user. Provide either userId OR guestInfo. */
  @IsOptional() @IsMongoId() userId?: string;

  /** Info to create a guest account when the phone does not exist in DB. */
  @IsOptional() @ValidateNested() @Type(() => GuestInfoDto) guestInfo?: GuestInfoDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => ShippingInfoDto)
  shippingInfo: ShippingInfoDto;

  @IsOptional() @IsString() customerNote?: string;
  @IsOptional() @IsString() adminNote?: string;

  /** Direct discount applied by admin (bypasses coupon system) */
  @IsOptional() @ValidateNested() @Type(() => AdminDirectDiscountDto)
  adminDiscount?: AdminDirectDiscountDto;

  /** Shipping fee added to the order total */
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;
}
