import { IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';

export class UpdateSettingDto {
  @IsUrl({ require_protocol: true }, { message: 'URL không hợp lệ (cần có http:// hoặc https://)' })
  @IsOptional()
  demoRedirectUrl?: string;

  @IsInt({ message: 'Thời gian phải là số nguyên (giây)' })
  @Min(1, { message: 'Thời gian phải lớn hơn 0 giây' })
  @Max(300, { message: 'Thời gian không quá 300 giây' })
  @IsOptional()
  demoRedirectSeconds?: number;
}
