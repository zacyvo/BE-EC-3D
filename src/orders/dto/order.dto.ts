import {
  IsBoolean,
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
import { EInvoiceBuyerType, OrderStatus, PaymentMethod } from '../schemas/order.schema';
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

  /** Customer asks for a VAT e-invoice — prices include VAT (total unchanged), shop approves. */
  @IsOptional() @ValidateNested() @Type(() => EInvoiceRequestDto)
  einvoiceRequest?: EInvoiceRequestDto;

  /** The customer ticked "Tôi đồng ý với Điều khoản dịch vụ và Chính sách bảo mật" (storefront
   * enforces it; optional here so a cached older page can't break checkout during a deploy). */
  @IsOptional() @IsBoolean() acceptTerms?: boolean;

  /** COD (default) or BANK_TRANSFER (VietQR). The amount is always computed server-side. */
  @IsOptional() @IsEnum(PaymentMethod, { message: 'Phương thức thanh toán không hợp lệ' })
  paymentMethod?: PaymentMethod;
}

/** Admin CMS "Xác nhận đã thanh toán" — `expectedAmount` is the amount shown in the dialog; the
 * confirmation is refused if the order total changed since (stale screen). */
export class ConfirmPaymentDto {
  @IsOptional() @IsNumber() @Min(0) expectedAmount?: number;
}

export class RefundAccountDto {
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập ngân hàng nhận hoàn tiền' }) @MaxLength(100)
  bankName: string;
  @Transform(trim) @IsString() @Matches(/^[0-9A-Za-z]{4,19}$/, { message: 'Số tài khoản không hợp lệ' })
  accountNumber: string;
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập chủ tài khoản' }) @MaxLength(100)
  accountHolder: string;
}

/** Admin CMS "Xác nhận đã hoàn tiền" — records a refund the shop already transferred by hand. */
export class RefundPaymentDto {
  @IsNumber({}, { message: 'Số tiền hoàn không hợp lệ' }) @Min(1, { message: 'Số tiền hoàn phải lớn hơn 0' })
  amount: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) transferRef?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
  @IsOptional() @ValidateNested() @Type(() => RefundAccountDto) refundAccount?: RefundAccountDto;
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

// ─── Điều chỉnh đơn hàng (shop-initiated order adjustment) ───────────────────

/** One line of the adjusted order. `unitPrice` keeps / overrides the price (e.g. the price the
 * customer originally paid); absent → the current catalog price of the selected variant. */
export class AdjustmentItemDto {
  @IsMongoId() productId: string;
  @IsNumber() @Min(1) @Max(10_000) quantity: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Super Admin proposes a new version of the order; nothing changes until the customer accepts. */
export class ProposeOrderAdjustmentDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Đơn hàng phải có ít nhất 1 sản phẩm' })
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemDto)
  items: AdjustmentItemDto[];

  /** Absent → keep the current recipient/address. */
  @IsOptional() @ValidateNested() @Type(() => ShippingInfoDto) shippingInfo?: ShippingInfoDto;

  /** Shipping fee the customer pays (net). Absent → keep the current one. */
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;

  /** Total discount on the goods. Absent → keep the current one (capped at the new subtotal). */
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;

  /** Absent → keep; '' → clear. */
  @IsOptional() @IsString() @MaxLength(1000) customerNote?: string;

  /** Shown to the customer — why the order is being changed. */
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Vui lòng nhập lý do điều chỉnh để gửi khách hàng' }) @MaxLength(500)
  reason: string;

  /** Order version the admin edited — refused if the order changed since (stale screen). */
  @IsOptional() @IsNumber() expectedVersion?: number;
}

export class WithdrawOrderAdjustmentDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

/** Customer accepts adjustment `number`. A refund needs the account to send it to; an extra
 * payment needs how the customer will pay it. */
export class AcceptOrderAdjustmentDto {
  @IsNumber() @Min(1) number: number;
  @IsOptional() @ValidateNested() @Type(() => RefundAccountDto) refundAccount?: RefundAccountDto;
  @IsOptional() @IsEnum(PaymentMethod, { message: 'Vui lòng chọn hình thức thanh toán phần còn lại' })
  extraPaymentMethod?: PaymentMethod;
}

export class RejectOrderAdjustmentDto {
  @IsNumber() @Min(1) number: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

/** Admin records that the refund was sent / the extra payment was received. */
export class CompleteAdjustmentSettlementDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) transferRef?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
