# Mua hàng không cần đăng nhập (guest checkout)

## Luồng
1. Khách chưa đăng nhập → giỏ hàng → `/checkout` (không còn bắt đăng nhập). Trang hiện thông báo
   "đặt hàng không cần đăng nhập" + nút Đăng nhập.
2. `POST /orders/guest-checkout` (body giống `POST /orders`, bắt buộc `acceptTerms: true`).
3. Backend tìm/tạo **user tạm** theo SĐT người nhận, tạo đơn với `placedAsGuest: true` và
   "Link xem đơn" (`publicAccessToken` / `publicAccessCode` / `publicAccessPhone` = SĐT người nhận).
4. Trang thành công hiện **link + SĐT + mã bảo mật (chỉ 1 lần)**, nút sao chép; đơn CK thì hiện luôn
   VietQR + "Tôi đã chuyển khoản" qua link. Phiên xem đơn được mở sẵn trong tab (sessionStorage);
   link (không có mã) được nhớ trong localStorage — "Đơn đã đặt trên thiết bị này".
5. Theo dõi đơn: `/order/<token>` → SĐT + mã bảo mật, **hoặc "Quên mã bảo mật"** → SĐT + số nhà, tên đường.
6. Mất link: `/order-lookup` (Tra cứu đơn hàng — Navbar, Footer, trang Hỗ trợ khi chưa đăng nhập):
   SĐT + mã → mở đơn đó; SĐT + số nhà, tên đường → mọi đơn của SĐT giao tới địa chỉ đó.

## User tạm (`UsersService.findOrCreateCheckoutGuest`)
- Khoá theo email cố định `guest_<sđt>@guest.luxe-glow.vn`, `isGuest: true`, không mật khẩu
  (cùng bản ghi mà admin tạo khi "Tạo đơn" cho SĐT mới).
- **Không bao giờ gắn đơn guest vào tài khoản thật** có cùng SĐT: SĐT tài khoản không được xác thực
  (không OTP), gắn vào sẽ cho người đăng ký "giả" SĐT xem địa chỉ của khách khác. Khi đó user tạm
  được tạo không có `phone` (SĐT vẫn nằm ở đơn / `publicAccessPhone`).
- User tạm bị khoá (`isBlocked`) → không đặt hàng được (403).
- **Đăng ký / sửa hồ sơ với SĐT đang thuộc user tạm**: user tạm nhả SĐT (`$unset phone`), tài khoản
  mới nhận SĐT. Đơn cũ **không** chuyển sang tài khoản mới (chưa có OTP), vẫn xem qua link.
  SĐT thuộc tài khoản thật khác → 409 "Số điện thoại đã được sử dụng cho tài khoản khác"
  (trước đây là lỗi 500 duplicate key).

## Quy tắc
- Khách không đăng nhập **không dùng được mã giảm giá** (giới hạn lượt/khách sẽ bị lách bằng cách đổi SĐT).
- Không lưu địa chỉ vào sổ địa chỉ, không xoá giỏ hàng server (giỏ khách chỉ ở trình duyệt).
- Huỷ đơn / yêu cầu HĐĐT sau khi đặt / trả hàng vẫn cần đăng nhập (hoặc liên hệ shop) — chưa làm qua link.
- Audit: `GUEST_CREATE_ORDER`; lịch sử phiên bản "Order created (guest checkout)".

## So khớp địa chỉ ("Quên mã bảo mật")
`streetMatches` (order-public-access.util.ts): so sánh **số nhà, tên đường** sau khi bỏ dấu tiếng Việt,
hoa/thường, dấu câu, khoảng trắng ("12/3 Nguyễn Huệ" = "12/3 nguyen hue"), so sánh constant-time,
tối thiểu 3 ký tự. Phường/tỉnh không dùng (khách chọn địa chỉ cũ/mới khác nhau). Nếu admin sửa
địa chỉ giao hàng, khách phải nhập địa chỉ mới.

## API
| Method | Path | Auth | Mô tả |
|---|---|---|---|
| POST | `/orders/guest-checkout` | — (8 lần / 10 phút / IP) | Đặt hàng → `{ order, publicAccess { token, publicUrl, securityCode, phone, accessJwt } }` |
| POST | `/orders/public/:token/verify` | — (10/phút) | `{ phone, securityCode }` **hoặc** `{ phone, street }` |
| POST | `/orders/public/lookup` | — (10/phút) | `{ phone, securityCode \| street }` → `{ orders: [{ token, accessJwt, orderCode, status, total, ... }] }` |
| GET | `/orders/public/:token/payment` | `X-Order-Access` | Hướng dẫn VietQR |
| POST | `/orders/public/:token/payment/report` | `X-Order-Access` (10/phút) | "Tôi đã chuyển khoản" |

## Bảo mật
- Sai 5 lần liên tiếp (mã hoặc địa chỉ) → khoá 15 phút. Tra cứu không link: mỗi lần sai cộng vào
  **tất cả** đơn của SĐT đó; SĐT không có đơn và sai thông tin trả cùng một thông báo (không dò được SĐT).
- Throttle các endpoint công khai dùng `ClientIpThrottlerGuard` (IP đầu tiên trong `X-Forwarded-For`):
  backend chạy sau proxy Render không bật `trust proxy`, nếu dùng `ThrottlerGuard` mặc định mọi khách
  chung một bucket → giờ cao điểm sẽ chặn đơn thật. Header này giả mạo được nên chỉ để chậm script, không
  phải kiểm soát truy cập.
- Dữ liệu trả về qua link vẫn là whitelist `toPublicView` (thêm `paymentMethod`).
- Index mới: `orders.publicAccessPhone` (sparse) — Mongoose tự tạo khi khởi động.

## Admin
Thẻ "Link xem đơn cho khách" ở chi tiết đơn có nhãn **"Khách đặt không đăng nhập"** (`placedAsGuest`),
dùng chung "Xem link & mã" / "Tạo link + mã mới" để gửi lại khi khách mất link.

## Hướng phát triển
- OTP SĐT (Zalo ZBS/SMS) để gộp đơn guest vào tài khoản khi khách đăng ký, và để cho phép dùng mã giảm giá.
- Huỷ đơn PENDING qua link; gửi link + mã qua Zalo ZBS / email sau khi đặt.
