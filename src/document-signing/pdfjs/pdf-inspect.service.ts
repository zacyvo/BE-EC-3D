import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { loadPdfjs, STANDARD_FONT_DATA_URL } from './pdfjs-loader';

export interface PdfInspection {
  pageCount: number;
  /** false với bản scan (chỉ có ảnh) — khi đó tamper-check không fallback so khớp văn bản được */
  hasTextLayer: boolean;
  sha256: string;
}

/** Số trang tối đa đọc text để xác định text layer — tránh tốn CPU với file rất dài */
const TEXT_PROBE_PAGES = 3;

/**
 * Kiểm tra file PDF do admin import (hợp đồng soạn ngoài hệ thống): đúng định dạng PDF, mở được,
 * không đặt mật khẩu (file có mật khẩu thì khách không xem được và không ký số chồng lên được).
 */
@Injectable()
export class PdfInspectService {
  private readonly logger = new Logger(PdfInspectService.name);

  async inspect(buffer: Buffer): Promise<PdfInspection> {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('File không phải định dạng PDF hợp lệ');
    }

    const pdfjsLib = await loadPdfjs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: true,
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages < 1) throw new BadRequestException('File PDF không có trang nào');

      let hasTextLayer = false;
      for (let i = 1; i <= Math.min(pdf.numPages, TEXT_PROBE_PAGES) && !hasTextLayer; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        hasTextLayer = content.items.some((item) => 'str' in item && item.str.trim().length > 0);
      }

      return {
        pageCount: pdf.numPages,
        hasTextLayer,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if ((err as Error)?.name === 'PasswordException') {
        throw new BadRequestException('File PDF đang được bảo vệ bằng mật khẩu — vui lòng gỡ mật khẩu rồi tải lên lại');
      }
      this.logger.warn(`Không đọc được file PDF import: ${(err as Error).message}`);
      throw new BadRequestException('File PDF bị lỗi hoặc không đọc được');
    } finally {
      await loadingTask.destroy();
    }
  }
}
