import { IsEnum, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ZbsCampaignAudience } from '../schemas/zbs-campaign.schema';

export class CreateZbsCampaignDto {
  @IsMongoId() promotionId: string;
  /** CouponItem._id inside the promotion. */
  @IsMongoId() couponId: string;
  @IsEnum(ZbsCampaignAudience) audience: ZbsCampaignAudience;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

export class ConfirmZbsCampaignDto {
  /** Must equal the draft's recipientCount — the admin restates how many paid messages go out. */
  @IsInt() @Min(1) expectedRecipients: number;
}
