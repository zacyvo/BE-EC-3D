import * as path from 'path';
import type * as PdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs-dist >=4 chỉ phát hành dưới dạng ESM (không còn build CJS) — project này chạy CommonJS
// nên phải nạp bằng dynamic import(), nạp 1 lần và cache lại promise cho các lần gọi sau. Dùng
// bản >=4.2.67 (không dùng 3.x) vì 3.x dính CVE thực thi JS tuỳ ý khi mở PDF độc hại
// (GHSA-wgrm-67xf-hhpq) — các endpoint upload PDF nhận file từ khách hàng / admin ngoài hệ thống.
//
// Với target CommonJS, TypeScript hạ cấp `import(...)` thành `require(...)` — require() không
// nạp được module ESM-only trên mọi phiên bản Node (chỉ Node >=22.12 mới hỗ trợ, và server chạy
// production có thể là bản cũ hơn). Dùng `new Function` để tạo import() thật, tránh bị TS đụng vào
// vì nội dung nằm trong chuỗi, không được compiler phân tích cú pháp.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof PdfjsLib>;

let pdfjsLibPromise: Promise<typeof PdfjsLib> | undefined;
export function loadPdfjs(): Promise<typeof PdfjsLib> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLibPromise;
}

export const STANDARD_FONT_DATA_URL = `${path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts',
)}${path.sep}`;
