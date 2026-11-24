# Banner / Hero quảng cáo trang chủ

Admin tạo banner (ảnh desktop + mobile, liên kết, lịch chạy) để chạy chương trình quảng cáo/khuyến mãi
trên trang chủ website. Banner tự chuyển slide; khách bấm vào thì đi tới trang được liên kết.

## Vị trí (placement)

| Vị trí | Hiển thị | Không có banner nào đang chạy |
|---|---|---|
| `HERO` | Slider lớn trên cùng, tràn bề ngang (tối đa 1920px) | Hiện **Hero mặc định** (`HeroSection`) |
| `PROMO` | Dải banner bo góc ngay dưới "Sản phẩm nổi bật" | Ẩn dải này (trang như trước) |

Tối đa 10 banner/vị trí trả về cho trang chủ (`MAX_PUBLIC_BANNERS_PER_PLACEMENT`).

## Kích thước ảnh chuẩn

| Vị trí | Desktop (≥ 900px) | Mobile (< 900px) |
|---|---|---|
| HERO | 1920×720 (8:3), tối thiểu rộng 1440 | 1080×1080 (1:1), tối thiểu rộng 750 |
| PROMO | 2400×600 (4:1), tối thiểu rộng 1200 | 1080×540 (2:1), tối thiểu rộng 750 |

- JPG / PNG / WebP, tối đa 10MB (khuyến nghị < 1.5MB). Vùng an toàn: chữ/logo trong 80–85% giữa ảnh desktop, 90% ảnh mobile.
- Admin kiểm tra ngay khi chọn file: **nhỏ hơn bề rộng tối thiểu → không cho tải lên**; lệch tỉ lệ > 3% hoặc file > 1.5MB → cảnh báo (vẫn cho lưu), khung xem trước cho thấy phần bị cắt.
- Ảnh mobile tuỳ chọn. Thiếu thì: nếu cả slider không có ảnh mobile nào → mobile dùng khung tỉ lệ desktop; nếu có banner khác có ảnh mobile → slide thiếu ảnh hiển thị trọn ảnh desktop trên nền mờ.
- Tỉ lệ khung khai báo ở **2 nơi**, sửa phải sửa cả hai: `frontend-admin/src/lib/banner-specs.ts` (`BANNER_SPECS`) và `frontend-user/src/lib/banners.ts` (`BANNER_RATIO`).
- Ảnh tải lên Cloudinary thư mục `web-ec-3d/banners` qua `POST /upload/banner-images` (staff). Trang chủ chèn `f_auto,q_auto,w_…` vào URL Cloudinary để tải đúng bề rộng; `<picture>` nên trình duyệt chỉ tải 1 ảnh.

## Liên kết (`linkType`)

| linkType | Lưu | Trang chủ nhận (`href`) |
|---|---|---|
| `NONE` | — | `null` (không bấm được) |
| `PRODUCT` | `productId` | `/products/<slug hiện tại>`; sản phẩm bị ẩn/xoá → `/products` |
| `INTERNAL` | `linkUrl` bắt đầu `/` (không nhận `//`) | `linkUrl` (Next `<Link>`) |
| `EXTERNAL` | `linkUrl` `https://`, `http://`, `tel:`, `mailto:` | `linkUrl`, `rel="noopener noreferrer"` |

`openInNewTab` áp dụng cho mọi loại có liên kết. Admin có sẵn nút điền nhanh Zalo / Shopee / TikTok / Facebook / Gọi điện
(trùng `frontend-user/src/lib/store-config.ts`) và danh sách trang trong website hay dùng.

## Lịch chạy

Banner hiển thị khi `isActive && (startAt trống hoặc ≤ now) && (endAt trống hoặc > now)`.
Trạng thái tính lúc truy vấn (không lưu): `INACTIVE` (tắt) · `SCHEDULED` (chờ đến giờ) · `RUNNING` · `EXPIRED`.

- Trang chủ lấy banner phía server với ISR 60s → bật/tắt/sửa banner có hiệu lực trên trang chủ **trong khoảng 1 phút**.
- Client lọc lại `startAt/endAt` theo đồng hồ trình duyệt mỗi phút, nên banner hết hạn biến mất đúng giờ kể cả khi trang còn trong cache.
- Không gọi được backend lúc render (timeout 4s) → client tự gọi lại `/banners`; lỗi tiếp → coi như không có banner → giao diện mặc định.

## API

Public (không cần đăng nhập):
- `GET /banners?placement=HERO|PROMO` — banner đang chạy, sắp theo `sortOrder` (không có `clickCount`, người tạo).
- `POST /banners/:id/click` — đếm lượt bấm (throttle 30/phút/IP, id sai bỏ qua lặng lẽ).

Admin (`SUPER_ADMIN`, `ADMIN`):
- `GET /admin/banners[?placement=]` → `{ items (có status, clickCount), runningCounts, serverTime }`
- `GET /admin/banners/:id`, `POST /admin/banners`, `PATCH /admin/banners/:id`, `DELETE /admin/banners/:id`
- `PATCH /admin/banners/reorder` `{ placement, ids[] }` — `sortOrder = vị trí trong ids`.

Mọi thao tác ghi audit log module `banners` (`BANNER_CREATE/UPDATE/DELETE/REORDER`). Xoá banner không xoá ảnh trên Cloudinary.

## Giao diện

- Admin: menu **Banner quảng cáo** (`/banners`) — tab Hero / Banner khuyến mãi, ô trạng thái "trang chủ đang hiển thị gì", bảng kích thước chuẩn, danh sách (thứ tự ↑↓, bật/tắt, sửa, xoá, lượt bấm), form có kiểm tra ảnh + xem trước vùng an toàn + chọn sản phẩm.
- Trang chủ: `frontend-user/src/components/layout/BannerCarousel.tsx` — tự chạy 5s (hero) / 6s (promo), dừng khi hover/focus/tab ẩn/"giảm chuyển động"; vuốt trên mobile (vuốt không mở link), mũi tên desktop, chấm điều hướng, phím ← →.

## Kiểm thử

`npx jest src/banners` (MongoDB in-memory): trạng thái theo giờ, lọc public, thứ tự, liên kết sản phẩm theo slug, validate link/lịch, reorder sai vị trí, đếm click.
