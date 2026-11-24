# Link xem đơn (đơn tạo từ admin)

## Vấn đề
Đơn do admin tạo cho khách mới được gán vào tài khoản khách vãng lai (`isGuest`, email tạm, không mật khẩu)
→ khách không đăng nhập được nên không thấy đơn.

## Giải pháp (giống link hợp đồng)
Mỗi đơn tạo từ admin tự sinh:
- `publicAccessToken` — 48 hex, nằm trong link `FRONTEND_URL/order/<token>`
- `publicAccessCode` — mã 8 ký tự (bỏ 0/O, 1/I), `select: false`, bị loại khỏi toJSON / aggregate / lịch sử phiên bản
- `publicAccessPhone` — SĐT khách phải nhập (SĐT tài khoản, nếu không có thì SĐT người nhận)

Khách mở link → nhập SĐT + mã → nhận JWT `typ=order-access` (4h, gắn với token) → xem đơn. Không cần đăng nhập.

## API
| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/orders/public/:token/meta` | — | Mã đơn + SĐT che (`091****678`) |
| POST | `/orders/public/:token/verify` | — (throttle 10/phút) | `{ phone, securityCode }` → `{ accessJwt, order }` |
| GET | `/orders/public/:token` | header `X-Order-Access` | Dữ liệu đơn (whitelist) |
| POST | `/admin/orders/for-user` | SUPER_ADMIN | Response có thêm `publicAccess { publicUrl, securityCode, phone }` (hiện 1 lần) |
| POST | `/admin/orders/:id/public-access` | SUPER_ADMIN, ADMIN | `{ password, regenerate? }` — xem lại / tạo link cho đơn cũ / tạo link + mã mới |

## Quy tắc bảo mật
- Sai SĐT hoặc mã 5 lần liên tiếp → khoá 15 phút (đếm bằng `$inc` nguyên tử).
- So sánh mã constant-time; token sai định dạng bị từ chối trước khi query.
- Dữ liệu trả cho khách là whitelist (`toPublicView`): không có adminNote, userId, createdByStaffId, payment history...
- Xem lại / tạo mới mã yêu cầu nhập lại mật khẩu admin, ghi Audit Log (`ORDER_PUBLIC_ACCESS_REVEAL|ISSUE|REGENERATE`).
- Tạo link + mã mới → link cũ và mọi phiên khách đang mở hết hiệu lực.
- Đơn sàn (`externalRef`, SĐT bị che) không cấp link. Đơn đã xoá mềm không mở được.
- CORS: header `X-Order-Access` đã thêm vào `allowedHeaders` (main.ts).

## Mở rộng (2026-11-24) — xem docs/GUEST_CHECKOUT.md
- Đơn đặt không cần đăng nhập trên storefront cũng tự có link + mã (SĐT người nhận).
- "Quên mã bảo mật": `verify` nhận `{ phone, street }` thay cho mã.
- `POST /orders/public/lookup` — tra cứu khi mất link; thanh toán VietQR qua link.

## Phạm vi hiện tại
Chỉ xem đơn (trạng thái, sản phẩm, tiền, giao hàng, mã vận đơn). Khách chưa thể huỷ / yêu cầu HĐĐT / trả hàng
qua link này — các thao tác đó vẫn cần đăng nhập.

## Đơn cũ
Không cần migration: admin mở chi tiết đơn → "Link xem đơn cho khách" → "Tạo link xem đơn".
