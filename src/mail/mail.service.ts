import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('MAIL_HOST', 'smtp.gmail.com'),
      port: this.config.get<number>('MAIL_PORT', 587),
      secure: false,
      auth: {
        user: this.config.get<string>('MAIL_USER'),
        pass: this.config.get<string>('MAIL_PASS'),
      },
    });
  }

  async sendDeleteAccountCode(to: string, code: string): Promise<void> {
    const from = `"3D Shop" <${this.config.get<string>('MAIL_USER')}>`;
    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Mã xác nhận xóa tài khoản',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:32px;">
            <h2 style="color:#ef4444;margin-top:0">Xóa tài khoản</h2>
            <p style="color:#374151">Chúng tôi nhận được yêu cầu xóa tài khoản của bạn.</p>
            <p style="color:#374151">Mã xác nhận của bạn là:</p>
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
              <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#dc2626;font-family:monospace;">${code}</span>
            </div>
            <p style="color:#6b7280;font-size:13px">Mã này có hiệu lực trong <strong>5 phút</strong> và chỉ sử dụng được một lần.</p>
            <p style="color:#6b7280;font-size:13px">Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email này.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:12px;text-align:center">3D Shop — Không trả lời email này</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send delete-account email', err);
      throw err;
    }
  }
}
