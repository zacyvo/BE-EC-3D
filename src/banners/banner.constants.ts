/**
 * Vị trí hiển thị banner trên trang chủ website khách hàng.
 * - HERO: slider lớn trên cùng, thay cho Hero mặc định khi có ít nhất một banner đang chạy.
 * - PROMO: dải banner khuyến mãi dưới "Sản phẩm nổi bật"; không có banner nào đang chạy thì ẩn.
 */
export enum BannerPlacement {
  HERO = 'HERO',
  PROMO = 'PROMO',
}

/**
 * Cách banner liên kết khi khách bấm vào.
 * - NONE: không bấm được.
 * - PRODUCT: trang chi tiết sản phẩm (productId) — đường dẫn lấy theo slug hiện tại lúc hiển thị.
 * - INTERNAL: đường dẫn trong website, bắt đầu bằng "/" (VD /custom-order, /guide/den-3-mau).
 * - EXTERNAL: URL ngoài website (Zalo, Shopee, TikTok, Facebook...) — http(s)://, tel: hoặc mailto:.
 */
export enum BannerLinkType {
  NONE = 'NONE',
  PRODUCT = 'PRODUCT',
  INTERNAL = 'INTERNAL',
  EXTERNAL = 'EXTERNAL',
}

/** Trạng thái hiển thị — tính từ isActive + startAt/endAt tại thời điểm truy vấn, không lưu. */
export type BannerStatus = 'INACTIVE' | 'SCHEDULED' | 'RUNNING' | 'EXPIRED';

/** Số banner tối đa mỗi vị trí trả về cho trang chủ (slider nhiều hơn thế khách không xem hết). */
export const MAX_PUBLIC_BANNERS_PER_PLACEMENT = 10;

export const INTERNAL_PATH_REGEX = /^\/(?!\/)[^\s]*$/;
export const EXTERNAL_URL_REGEX = /^(https?:\/\/[^\s]+|tel:[+\d][\d\s.-]*|mailto:[^\s@]+@[^\s@]+)$/i;
