import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReturnReason } from '../../orders/schemas/order.schema';
import { RETURN_MAX_IMAGES } from '../order-return.constants';

export class ReturnItemInputDto {
  /** Index into Order.items. */
  @IsInt() @Min(0) itemIndex: number;
  @IsInt() @Min(1) quantity: number;
}

export class RefundAccountDto {
  @IsString() @MinLength(2) @MaxLength(100) bankName: string;
  @IsString() @Matches(/^[0-9A-Za-z]{4,30}$/, { message: 'Số tài khoản không hợp lệ' }) accountNumber: string;
  @IsString() @MinLength(2) @MaxLength(100) accountHolder: string;
}

export class CreateReturnRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemInputDto)
  items: ReturnItemInputDto[];

  @IsEnum(ReturnReason) reason: ReturnReason;

  @IsString() @MinLength(10, { message: 'Vui lòng mô tả rõ tình trạng sản phẩm (tối thiểu 10 ký tự)' }) @MaxLength(1000)
  description: string;

  /** Evidence photos uploaded via POST /upload/return-images. */
  @IsArray()
  @ArrayMinSize(1, { message: 'Vui lòng đính kèm ít nhất 1 ảnh sản phẩm' })
  @ArrayMaxSize(RETURN_MAX_IMAGES)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @Matches(/^https:\/\/res\.cloudinary\.com\//, { each: true, message: 'Ảnh phải được tải lên qua hệ thống' })
  images: string[];

  /** Required when the order has a recorded payment (something to refund). */
  @IsOptional() @ValidateNested() @Type(() => RefundAccountDto) refundAccount?: RefundAccountDto;
}

export class ReturnShipmentDto {
  @IsOptional() @IsString() @MaxLength(100) carrierName?: string;
  @IsString() @MinLength(4) @MaxLength(50) trackingCode: string;
}

export class ApproveReturnDto {
  /** Instructions shown to the customer (where/how to send the parcel back). */
  @IsOptional() @IsString() @MaxLength(1000) shopNote?: string;
}

export class RejectReturnDto {
  @IsString() @MinLength(5) @MaxLength(1000) reason: string;
}

export class ReceiveReturnDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class InspectReturnDto {
  /** true = goods meet the return conditions → refund; false = rejected after inspection. */
  @IsBoolean() passed: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** Refund for the goods (defaults to the request's estimate). Ignored when !passed. */
  @IsOptional() @IsNumber() @Min(0) refundAmount?: number;
  /** Return shipping reimbursed to the customer (shop-fault returns). Ignored when !passed. */
  @IsOptional() @IsNumber() @Min(0) returnShippingRefund?: number;
}

export class CompleteRefundDto {
  @IsOptional() @IsString() @MaxLength(100) transferRef?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
