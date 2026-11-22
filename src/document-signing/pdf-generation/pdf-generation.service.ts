import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as pdfMake from 'pdfmake';
import { buildContractDocDefinition, ContractPdfInput } from './contract-pdf.definition';
import { buildJoyloveAdvanceDocDefinition } from './joylove-advance-pdf.definition';
import { AddendumPdfInput, buildAddendumDocDefinition } from './addendum-pdf.definition';

const FONTS_DIR = path.join(__dirname, 'fonts');
/** Roboto đi kèm package pdfmake (không có Bold → dùng Medium) — dự phòng khi thiếu file trong fonts/ */
const BUNDLED_FONTS_DIR = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
const logger = new Logger('PdfGenerationService');

function fontFile(own: string, bundled: string): string {
  const ownPath = path.join(FONTS_DIR, own);
  if (fs.existsSync(ownPath)) return ownPath;
  logger.warn(`Thiếu font ${ownPath} — dùng ${bundled} đi kèm pdfmake`);
  return path.join(BUNDLED_FONTS_DIR, bundled);
}

/**
 * Font Roboto — bắt buộc phải nhúng vì bộ font chuẩn 14 (Helvetica/Times/Courier) của PDF
 * không có glyph tiếng Việt có dấu (ư, ơ, ệ…) và toàn bộ nội dung hợp đồng là tiếng Việt.
 * Ưu tiên file trong fonts/ (Roboto Bold thật); thiếu file nào thì lấy bản đi kèm pdfmake thay
 * vì để sinh PDF lỗi ENOENT (từng xảy ra khi thư mục fonts/ bị xoá khỏi repo).
 *
 * Lưu ý: phải gọi qua namespace `pdfMake.setFonts(...)` (không destructure) — các hàm này dùng
 * `this` trỏ vào singleton nội bộ của pdfmake, destructure sẽ làm mất `this` binding.
 */
pdfMake.setFonts({
  Roboto: {
    normal: fontFile('Roboto-Regular.ttf', 'Roboto-Regular.ttf'),
    bold: fontFile('Roboto-Bold.ttf', 'Roboto-Medium.ttf'),
    italics: fontFile('Roboto-Italic.ttf', 'Roboto-Italic.ttf'),
    bolditalics: fontFile('Roboto-BoldItalic.ttf', 'Roboto-MediumItalic.ttf'),
  },
});
// docDefinition không bao giờ nhúng ảnh/URL từ dữ liệu hợp đồng — khoá truy cập URL ngoài, và chỉ
// cho phép đọc file local trong đúng 2 thư mục font (nơi pdfmake tự đọc font khi đo/dựng trang)
// để tránh SSRF/local file read nếu sau này có ai vô tình thêm image url động vào definition.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy(
  (filePath: string) => filePath.startsWith(FONTS_DIR) || filePath.startsWith(BUNDLED_FONTS_DIR),
);

@Injectable()
export class PdfGenerationService {
  /** Sinh PDF hợp đồng chưa ký (bản chính tắc — chỉ gọi 1 lần tại thời điểm chuyển FINAL). */
  async generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
    const docDefinition =
      input.template === 'JOYLOVE_ADVANCE'
        ? buildJoyloveAdvanceDocDefinition(input)
        : buildContractDocDefinition(input);
    const pdfDoc = pdfMake.createPdf(docDefinition);
    return pdfDoc.getBuffer();
  }

  /** Sinh PDF phụ lục hợp đồng — bản chính tắc khi chốt, hoặc bản xem trước (có watermark) */
  async generateAddendumPdf(input: AddendumPdfInput): Promise<Buffer> {
    return pdfMake.createPdf(buildAddendumDocDefinition(input)).getBuffer();
  }
}
