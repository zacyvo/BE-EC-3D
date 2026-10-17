import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class RetryNotificationDto {
  /** Required to retry an UNKNOWN job: the admin confirms the owner did NOT receive it. */
  @IsOptional() @IsBoolean() confirmUnknownOutcome?: boolean;
}

export class SendTestMessageDto {
  /** "env:<index>" or a recipient row id, as returned by GET /admin/zalo-bot/recipients. */
  @IsString() @MaxLength(64) recipientKey: string;
}
