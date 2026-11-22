# Phụ lục hợp đồng (sửa đổi, bổ sung)

Hợp đồng đã chốt (FINAL) mà khách muốn mua thêm / gia công thêm thì lập **phụ lục** thay vì hợp đồng mới.
Văn bản hợp đồng gốc giữ nguyên; tổng thanh toán = giá trị hợp đồng gốc + các phụ lục đã chốt.

## Nghiệp vụ

| Quy tắc | Chi tiết |
|---|---|
| Khi nào lập được | Chỉ khi hợp đồng `FINAL` (TEMPLATE và IMPORTED). NEW/REVIEW/DRAFT → sửa thẳng hợp đồng; SUCCESS/CLOSED → không lập. |
| Trạng thái phụ lục | `DRAFT` (admin soạn, khách không thấy) → `FINAL` (khoá nội dung, sinh PDF chính tắc, cộng vào tổng) → `CANCELLED` (cần lý do, trừ khỏi tổng). Bản nháp xoá được; phụ lục đã chốt chỉ hủy được. |
| Nội dung | Ít nhất 1 hạng mục hoặc nội dung sửa đổi. Hạng mục: sản phẩm danh mục (giá vốn lấy từ sản phẩm) hoặc tự nhập (gia công, dịch vụ — admin nhập giá vốn). Giá trị = tổng thành tiền, có thể 0 (VD: chỉ đổi ngày giao). |
| Thanh toán | Lịch riêng cho giá trị phụ lục, 1–5 lần, tổng 100%. Mặc định: gộp vào lần thanh toán cuối của HĐ. |
| Số phụ lục | Tăng dần, không dùng lại số đã xoá/hủy. JOYLOVE_ADVANCE bắt đầu từ **03** (văn bản HĐ đã có Phụ lục 01/02). |
| Ký số | Mỗi phụ lục có PDF + chữ ký riêng, cùng quy tắc với hợp đồng: Bên B ký trên hệ thống (.p12 / chứng thư server) hoặc ký ngoài rồi tải lên; Bên A ký PKI chồng lên hoặc ký đơn giản (canvas) qua link hợp đồng. |
| Hoàn tất HĐ (SUCCESS) | Bị chặn nếu còn phụ lục DRAFT hoặc phụ lục FINAL chưa có chữ ký Bên B VERIFIED. Doanh thu ghi nhận = `totalAmount + addendaAmount`, giá vốn cộng hạng mục phụ lục. |
| HĐĐT | Prefill hoá đơn từ hợp đồng (admin) gồm cả hạng mục phụ lục đã chốt. |

## Dữ liệu

`Contract.addenda[]` (subdocument `ContractAddendum`, có `_id`) + `Contract.addendaAmount` (tổng phụ lục FINAL,
tính lại sau mỗi thao tác). API admin/khách trả thêm `grandTotalAmount`. Khách chỉ nhận phụ lục FINAL/CANCELLED,
không có giá vốn.

PDF lưu Cloudinary tại `contracts-signing/<contractId>/addendum-NN/{unsigned,party-b-signed,party-a-signed}`.
Văn bản phụ lục chỉ dựng bằng PDF (`document-signing/pdf-generation/addendum-pdf.definition.ts`) — không có bản HTML
ở frontend nên không phải đồng bộ 3 nơi như mẫu hợp đồng. Bản nháp xem trước dựng tại chỗ (chữ chìm BẢN NHÁP), không lưu.

## API

Admin — `admin/contracts/:id/addenda` (`contract-addenda.controller.ts`):

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/` | Tạo bản nháp (`CreateAddendumDto`) |
| PATCH / DELETE | `/:addendumId` | Chỉ bản nháp |
| POST | `/:addendumId/finalize` | Chốt + sinh PDF (lỗi sinh PDF không chặn — dùng `document/generate`) |
| POST | `/:addendumId/cancel` | `{ reason }` |
| GET | `/:addendumId/document/preview` | PDF xem trước (inline) |
| POST | `/:addendumId/document/generate` | Tạo PDF nếu chưa có |
| GET | `/:addendumId/document/unsigned`, `/signed` | Tải PDF chưa ký / bản ký số mới nhất |
| POST | `/:addendumId/document/sign` | Bên B ký trên hệ thống (multipart như ký hợp đồng) |
| POST | `/:addendumId/document/party-b-signed` | Bên B tải lên file đã ký ngoài |
| POST | `/:addendumId/document/party-a-signed/reject` | Từ chối chữ ký PKI Bên A |

Khách — `contracts/public/:token/addenda/:addendumId/document/` + `view`, `to-sign`, `party-a-signed`,
`party-a-simple-signature` (header `X-Contract-Access` như hợp đồng).

## Test

`NODE_OPTIONS=--experimental-vm-modules npx jest contract-addenda` — MongoDB in-memory, sinh PDF + ký PAdES thật.
