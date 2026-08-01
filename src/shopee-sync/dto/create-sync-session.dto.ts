import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSyncSessionDto {
  /** Reported by the extension via the Admin page's "ping" round-trip before sync starts. */
  @IsString()
  @MaxLength(30)
  extensionVersion: string;

  /** Restricted to SUPER_ADMIN at the controller level — see AdminIntegrationsShopeeController. */
  @IsOptional()
  @IsBoolean()
  forceFullSync?: boolean;
}
