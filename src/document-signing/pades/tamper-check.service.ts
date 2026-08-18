import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import type * as PdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs-dist >=4 chỉ phát hành dưới dạng ESM (không còn build CJS) — project này chạy CommonJS
// nên phải nạp bằng dynamic import(), nạp 1 lần và cache lại promise cho các lần gọi sau. Dùng
// bản >=4.2.67 (không dùng 3.x) vì 3.x dính CVE thực thi JS tuỳ ý khi mở PDF độc hại
// (GHSA-wgrm-67xf-hhpq) — endpoint upload file ký ở đây nhận file từ khách hàng ngoài hệ thống.
//
// Với target CommonJS, TypeScript hạ cấp `import(...)` thành `require(...)` — require() không
// nạp được module ESM-only trên mọi phiên bản Node (chỉ Node >=22.12 mới hỗ trợ, và server chạy
// production có thể là bản cũ hơn). Dùng `new Function` để tạo import() thật, tránh bị TS đụng vào
// vì nội dung nằm trong chuỗi, không được compiler phân tích cú pháp.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof PdfjsLib>;

let pdfjsLibPromise: Promise<typeof PdfjsLib> | undefined;
function loadPdfjs(): Promise<typeof PdfjsLib> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLibPromise;
}

const STANDARD_FONT_DATA_URL = `${path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts',
)}${path.sep}`;

/**
 * Đảm bảo file PDF mới upload là bản "incremental update" nối thêm từ file trước đó — không sửa
 * bất kỳ byte nào trong phần đã tồn tại. Đây là cách PDF signature hoạt động (mỗi lần ký chỉ nối
 * thêm 1 revision mới), nên đây cũng là cách duy nhất để đảm bảo Bên B/Bên A ký đúng bản hệ thống
 * đã tạo ra, không phải một bản nội dung khác đã bị chỉnh sửa.
 *
 * Trên thực tế, nhiều phần mềm ký số hợp lệ (kể cả Adobe Acrobat) khi mở 1 PDF không phải do
 * chính nó tạo ra sẽ tự "sửa/tối ưu" lại cấu trúc file (thứ tự object, xref, whitespace...) trước
 * khi ký — nội dung nhìn thấy không đổi nhưng byte thì khác, khiến check byte-for-byte false
 * positive. Vì vậy: ưu tiên so khớp byte-for-byte (rẻ, chắc chắn tuyệt đối); nếu không khớp mới
 * fallback sang so sánh NỘI DUNG VĂN BẢN đã trích xuất từ 2 file — vẫn bắt được việc chỉnh sửa
 * điều khoản hợp đồng, nhưng không bị false positive do công cụ ký hợp lệ tái cấu trúc file.
 */
@Injectable()
export class TamperCheckService {
  private readonly logger = new Logger(TamperCheckService.name);

  async assertIncrementalOnly(previousPdf: Buffer, newPdf: Buffer): Promise<void> {
    if (newPdf.length <= previousPdf.length) {
      throw new BadRequestException(
        'File tải lên không lớn hơn bản gốc — có vẻ không phải bản đã ký (chưa có chữ ký mới được nối thêm)',
      );
    }
    if (newPdf.subarray(0, previousPdf.length).equals(previousPdf)) {
      return;
    }

    const [previousText, newText] = await Promise.all([
      this.extractText(previousPdf),
      this.extractText(newPdf),
    ]);

    if (previousText === null || newText === null || !this.textsMatch(previousText, newText)) {
      throw new BadRequestException(
        'Nội dung file đã bị thay đổi so với bản gốc hệ thống đã tạo — không thể chấp nhận. Vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung.',
      );
    }

    this.logger.warn(
      'File đã ký không khớp byte-for-byte nhưng nội dung văn bản khớp — chấp nhận (công cụ ký đã tái cấu trúc file khi ký, ví dụ Adobe Acrobat).',
    );
  }

  private textsMatch(previousText: string, newText: string): boolean {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const prev = normalize(previousText);
    const next = normalize(newText);
    return prev.length > 0 && next.includes(prev);
  }

  private async extractText(buffer: Buffer): Promise<string | null> {
    const pdfjsLib = await loadPdfjs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: true,
    });
    try {
      const pdf = await loadingTask.promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
      }
      return text;
    } catch (err) {
      this.logger.warn(`Không trích xuất được văn bản PDF để so sánh nội dung: ${(err as Error).message}`);
      return null;
    } finally {
      await loadingTask.destroy();
    }
  }
}
