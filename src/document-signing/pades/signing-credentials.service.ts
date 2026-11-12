import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CertificateSummary, loadPkcs12, SignerCredentials, summarizeCertificate } from './pkcs12';

/**
 * Chứng thư số của Bên B (Luxe Glow) cấu hình sẵn trên server — cho phép ký "1 chạm" từ admin
 * mà không cần tải file .p12 mỗi lần:
 *   CONTRACT_SIGNING_P12_BASE64   = nội dung file .p12/.pfx mã hoá base64
 *   CONTRACT_SIGNING_P12_PASSWORD = mật khẩu file
 * Không cấu hình → admin vẫn ký được bằng cách tải file .p12 lên khi ký (không lưu lại).
 */
@Injectable()
export class SigningCredentialsService {
  private readonly logger = new Logger(SigningCredentialsService.name);
  private cached?: SignerCredentials | null;

  constructor(private readonly configService: ConfigService) {}

  private load(): SignerCredentials | null {
    if (this.cached !== undefined) return this.cached;
    const b64 = this.configService.get<string>('CONTRACT_SIGNING_P12_BASE64')?.replace(/\s+/g, '');
    if (!b64) {
      this.cached = null;
      return null;
    }
    try {
      this.cached = loadPkcs12(
        Buffer.from(b64, 'base64'),
        this.configService.get<string>('CONTRACT_SIGNING_P12_PASSWORD') ?? '',
      );
    } catch (err) {
      this.logger.error(`Chứng thư số cấu hình trên server không đọc được: ${(err as Error).message}`);
      this.cached = null;
    }
    return this.cached;
  }

  /** Thông tin chứng thư server (null nếu chưa cấu hình / cấu hình lỗi) */
  getServerCertificate(): CertificateSummary | null {
    const creds = this.load();
    return creds ? summarizeCertificate(creds.certificate) : null;
  }

  getServerCredentials(): SignerCredentials {
    const creds = this.load();
    if (!creds) {
      throw new BadRequestException(
        'Máy chủ chưa cấu hình chứng thư số (CONTRACT_SIGNING_P12_BASE64) — vui lòng tải file chứng thư .p12/.pfx lên để ký',
      );
    }
    return creds;
  }
}
