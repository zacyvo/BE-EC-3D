import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as pdfMake from 'pdfmake';
import { buildContractDocDefinition, ContractPdfInput } from './contract-pdf.definition';

const FONTS_DIR = path.join(__dirname, 'fonts');

/**
 * Font Roboto — bắt buộc phải nhúng vì bộ font chuẩn 14 (Helvetica/Times/Courier) của PDF
 * không có glyph tiếng Việt có dấu (ư, ơ, ệ…) và toàn bộ nội dung hợp đồng là tiếng Việt.
 *
 * Lưu ý: phải gọi qua namespace `pdfMake.setFonts(...)` (không destructure) — các hàm này dùng
 * `this` trỏ vào singleton nội bộ của pdfmake, destructure sẽ làm mất `this` binding.
 */
pdfMake.setFonts({
  Roboto: {
    normal: path.join(FONTS_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONTS_DIR, 'Roboto-Bold.ttf'),
    italics: path.join(FONTS_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONTS_DIR, 'Roboto-BoldItalic.ttf'),
  },
});
// docDefinition không bao giờ nhúng ảnh/URL từ dữ liệu hợp đồng — khoá truy cập URL ngoài, và chỉ
// cho phép đọc file local trong đúng thư mục fonts/ (nơi pdfmake tự đọc font khi đo/dựng trang)
// để tránh SSRF/local file read nếu sau này có ai vô tình thêm image url động vào definition.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((filePath: string) => filePath.startsWith(FONTS_DIR));

@Injectable()
export class PdfGenerationService {
  /** Sinh PDF hợp đồng chưa ký (bản chính tắc — chỉ gọi 1 lần tại thời điểm chuyển FINAL). */
  async generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
    const docDefinition = buildContractDocDefinition(input);
    const pdfDoc = pdfMake.createPdf(docDefinition);
    return pdfDoc.getBuffer();
  }
}
