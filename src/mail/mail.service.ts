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

  /** Báo khách: shop đề xuất điều chỉnh đơn hàng — khách vào trang đơn hàng để đồng ý/từ chối. */
  async sendOrderAdjustmentProposed(
    to: string,
    data: {
      customerName: string;
      orderCode: string;
      reason: string;
      beforeTotal: number;
      afterTotal: number;
      /** < 0 → shop hoàn lại; > 0 → khách trả thêm; 0 → không chênh lệch (hoặc đơn chưa thanh toán). */
      balance: number;
      orderUrl: string;
    },
  ): Promise<void> {
    if (!this.config.get<string>('MAIL_USER')) return;
    const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}đ`;
    const balanceLine =
      data.balance < 0
        ? `<p style="color:#065f46">Bạn sẽ được hoàn lại <strong>${vnd(-data.balance)}</strong> sau khi xác nhận.</p>`
        : data.balance > 0
          ? `<p style="color:#92400e">Bạn cần thanh toán thêm <strong>${vnd(data.balance)}</strong> (COD hoặc chuyển khoản).</p>`
          : '';
    await this.transporter.sendMail({
      from: `"Luxe Glow" <${this.config.get<string>('MAIL_USER')}>`,
      to,
      subject: `Luxe Glow đề xuất điều chỉnh đơn hàng ${data.orderCode}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:32px;">
          <h2 style="color:#111827;margin-top:0">Đề xuất điều chỉnh đơn hàng</h2>
          <p style="color:#374151">Xin chào ${escapeHtml(data.customerName)},</p>
          <p style="color:#374151">Luxe Glow đề xuất điều chỉnh đơn hàng <strong>${escapeHtml(data.orderCode)}</strong>:</p>
          <p style="color:#374151;background:#f9fafb;border-radius:8px;padding:12px;white-space:pre-wrap">${escapeHtml(data.reason)}</p>
          <p style="color:#374151">Tổng tiền: ${vnd(data.beforeTotal)} → <strong>${vnd(data.afterTotal)}</strong></p>
          ${balanceLine}
          <p style="color:#374151">Đơn hàng chỉ thay đổi khi bạn đồng ý. Vui lòng xem chi tiết và xác nhận:</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${escapeHtml(data.orderUrl)}" style="background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">Xem và xác nhận</a>
          </p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px;text-align:center">Luxe Glow — Không trả lời email này</p>
        </div>
      `,
    });
  }

  /** Gửi hoá đơn điện tử (VAT) đã phát hành cho khách đã yêu cầu xuất hoá đơn khi đặt hàng.
   * Đính kèm PDF nếu tải được từ EasyInvoice; link + khoá mở hoá đơn luôn có trong email. */
  async sendEInvoiceIssued(
    to: string,
    data: {
      customerName: string;
      orderCode: string;
      invoiceNo?: string;
      totalAmount: number;
      viewUrl: string;
      securityCode: string;
      sellerName: string;
      pdf?: { filename: string; content: Buffer };
    },
  ): Promise<void> {
    const from = `"${data.sellerName || 'Luxe Glow'}" <${this.config.get<string>('MAIL_USER')}>`;
    const total = `${new Intl.NumberFormat('vi-VN').format(Math.round(data.totalAmount))}đ`;
    const invoiceLine = data.invoiceNo ? ` số <strong>${escapeHtml(data.invoiceNo)}</strong>` : '';
    await this.transporter.sendMail({
      from,
      to,
      subject: `Hoá đơn điện tử cho đơn hàng ${data.orderCode}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:32px;">
          <h2 style="color:#111827;margin-top:0">Hoá đơn điện tử của bạn</h2>
          <p style="color:#374151">Xin chào ${escapeHtml(data.customerName)},</p>
          <p style="color:#374151">Cảm ơn bạn đã mua hàng. Hoá đơn điện tử (VAT)${invoiceLine} cho đơn hàng <strong>${escapeHtml(data.orderCode)}</strong> đã được phát hành.</p>
          <p style="color:#374151">Tổng tiền thanh toán (đã gồm VAT): <strong>${total}</strong></p>
          ${data.pdf ? '<p style="color:#374151">Hoá đơn được đính kèm trong email này (file PDF).</p>' : ''}
          <p style="color:#374151">Bạn cũng có thể xem và tải hoá đơn tại:</p>
          <p><a href="${escapeHtml(data.viewUrl)}" style="color:#2563eb">${escapeHtml(data.viewUrl)}</a></p>
          <p style="color:#374151">Khoá mở hoá đơn:</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;margin:12px 0 20px;">
            <span style="font-size:24px;font-weight:700;letter-spacing:6px;color:#111827;font-family:monospace;">${escapeHtml(data.securityCode)}</span>
          </div>
          <p style="color:#6b7280;font-size:13px">Vui lòng không chia sẻ khoá này cho người khác.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px;text-align:center">${escapeHtml(data.sellerName || 'Luxe Glow')} — Không trả lời email này</p>
        </div>
      `,
      ...(data.pdf ? { attachments: [{ filename: data.pdf.filename, content: data.pdf.content, contentType: 'application/pdf' }] } : {}),
    });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
