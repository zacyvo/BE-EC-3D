# Ký số hợp đồng trên hệ thống (Admin → Hợp đồng → chi tiết)

Cập nhật: 2026-11-12. Trạng thái: đã lên main (chưa thử với chứng thư CA thật).

Biến môi trường (tuỳ chọn, để trống nếu dùng USB token): `CONTRACT_SIGNING_P12_BASE64`, `CONTRACT_SIGNING_P12_PASSWORD`.

## Tính năng

- **Ký số trên hệ thống** — card "Tài liệu & Ký số", nút **Ký số trên hệ thống** (khi HĐ đã chốt FINAL/SUCCESS, Bên B chưa ký). Bên B (Luxe Glow) ký bằng chứng thư số dạng file PKCS#12:
  - **Tải file chứng thư** `.p12/.pfx` + mật khẩu — chỉ dùng trong request, không lưu.
  - **Chứng thư của hệ thống** — cấu hình qua env `CONTRACT_SIGNING_P12_BASE64` / `CONTRACT_SIGNING_P12_PASSWORD`; bắt buộc nhập lại mật khẩu tài khoản admin khi ký.
- **Xuất PDF đã ký số** — nút ở header trang và trên card; trả bản mới nhất: Bên A ký PKI (chồng lên) > Bên B.
- Luồng cũ **USB token** (tải PDF → ký ngoài → upload) giữ nguyên — USB token không xuất được khoá ra file `.p12`.

## Kỹ thuật

| Thành phần | File |
|---|---|
| Ký PAdES (CMS detached, SHA-256/RSA, `adbe.pkcs7.detached`) | `backend/src/document-signing/pades/pades-sign.service.ts` |
| Đọc `.p12/.pfx` (node-forge, chỉ RSA), kiểm hạn chứng thư | `backend/src/document-signing/pades/pkcs12.ts` |
| Vị trí khung chữ ký (tìm "ĐẠI DIỆN BÊN B" bằng pdfjs; không thấy → góc dưới phải trang cuối) | `backend/src/document-signing/pades/signature-placement.service.ts` |
| Chứng thư cấu hình trên server | `backend/src/document-signing/pades/signing-credentials.service.ts` |
| Nghiệp vụ | `ContractsService.signPartyBInSystem`, `acceptPartyBSignedPdf` (dùng chung với upload), `getSignedPdfBuffer` |
| Modal FE | `frontend-admin/src/components/SignContractModal.tsx` |

- Chữ ký ghi bằng **incremental update**: giữ nguyên từng byte file gốc → chữ ký cũ (nếu có) vẫn hợp lệ, `TamperCheckService` khớp byte-for-byte. Hỗ trợ file gốc dùng xref table hoặc xref stream (PDF import từ Word/Acrobat). pdf-lib chỉ dùng để đọc cấu trúc + dựng object, KHÔNG gọi `save()`.
- File đã ký đi qua đúng bước xác thực của luồng upload (tamper-check + `PadesVerifyService`) trước khi lưu Cloudinary và đặt `partyBSignature.status = VERIFIED`, `signMethod = SYSTEM_UPLOADED_CERT | SYSTEM_SERVER_CERT` (upload cũ: `EXTERNAL_UPLOAD`). Audit: `CONTRACT_PARTY_B_SIGNED_IN_SYSTEM`.
- Khung chữ ký: viền đỏ, "Ký bởi / Ngày ký (giờ VN) / Lý do / Chứng thư"; font Roboto nhúng subset (fallback Roboto đi kèm `pdfmake` nếu `pdf-generation/fonts/` trống).
- Bản vá node-forge: forge encode UTF-8 lần 2 cho DN tiếng Việt khi dựng `issuerAndSerialNumber` → Acrobat/poppler báo "signer certificate not found". Đã thay bằng issuer DER gốc (`useOriginalIssuerDer`). Đồng thời CN tiếng Việt giờ được decode đúng ở cả luồng upload (`certCommonName`).

## API

- `GET  /admin/contracts/signing-config` → `{ serverCertificate: { subjectCN, issuerCN, serialNumber, notBefore, notAfter, currentlyValid } | null }`
- `POST /admin/contracts/:id/document/sign` (multipart, SUPER_ADMIN/ADMIN, throttle 10/phút): `certificate` (file, khi UPLOAD), `certSource` = `UPLOAD|SERVER`, `certPassword`, `staffPassword`, `visible` (`'true'|'false'`, mặc định true). Sai mật khẩu trả **400** (không 401 để FE không tự refresh token).
- `GET  /admin/contracts/:id/document/signed` → PDF đã ký số mới nhất (404 nếu chưa ký).

## Kiểm thử

```
cd backend
NODE_OPTIONS=--experimental-vm-modules npx jest pades-sign contract-sign contract-import contract-template
```
(`--experimental-vm-modules` vì pdfjs-dist là ESM-only.) Đã kiểm chứng độc lập bằng poppler `pdfsig`: "Signature is Valid" cho cả 2 chữ ký chồng nhau, tên có dấu hiển thị đúng; `.p12` OpenSSL 3 (AES-256) và `-legacy` (3DES/RC2) đều đọc được.

## Giới hạn / việc còn lại

- Chưa xác minh chuỗi CA gốc / CRL / OCSP (giống luồng upload — `chainValidated=false`); chưa gắn dấu thời gian TSA (PAdES B-B, không có B-T/LTV).
- Chỉ khoá RSA (đủ cho CA Việt Nam hiện tại); không hỗ trợ USB token / ký số từ xa (SmartCA, MySign…) — cần tích hợp API nhà cung cấp riêng.
- Chưa thử với chứng thư CA thật trên Adobe Acrobat.
- Font Roboto trong `src/document-signing/pdf-generation/fonts/` bị xoá nhầm ở commit `217ded6` (12/09) → đã khôi phục 2026-11-12; thiếu file thì PdfGenerationService tự dùng Roboto đi kèm pdfmake (log cảnh báo).
