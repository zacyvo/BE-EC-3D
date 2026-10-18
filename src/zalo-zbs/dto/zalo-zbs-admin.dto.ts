import { IsBoolean, IsOptional } from 'class-validator';

export class RetryZbsNotificationDto {
  /** Required to retry an UNKNOWN job: the admin verified the customer did NOT receive it. */
  @IsOptional() @IsBoolean() confirmUnknownOutcome?: boolean;
}
