/** Channel identifier on notification_jobs rows (the owner Zalo Bot uses 'ZALO_BOT'). */
export const ZALO_ZBS_CHANNEL = 'ZALO_ZBS';

/** Outbox marker written into Order.pendingNotificationEvents by checkout when ZBS is
 * enabled. Separate from the Bot's 'ORDER_CREATED' marker so each channel records its own
 * intent at checkout time — an order placed while ZBS was disabled never gets one. */
export const ZBS_ORDER_OUTBOX_MARKER = 'ORDER_CREATED:ZALO_ZBS';

/** Customer template sent automatically on ORDER_CREATED. */
export const ZBS_TEMPLATE_ORDER_CONFIRMATION = 'ORDER_CONFIRMATION';

/** Promotion template, sent ONLY by admin-confirmed campaigns (zbs-promotion-campaign.service). */
export const ZBS_TEMPLATE_PROMOTION = 'PROMOTION';

/** recipientId used when the order has no usable phone number. */
export const ZBS_NO_RECIPIENT = '__invalid_phone__';

/** Zalo: "tối đa 48 ký tự, không chứa ký tự đặc biệt". */
export const ZBS_TRACKING_ID_MAX_LENGTH = 48;

/**
 * How a failed ZBS call must be handled (prompt §13):
 * - RETRYABLE: Zalo did not process the request (pre-connect network error, 429/5xx, -100) — safe to resend.
 * - NON_RETRYABLE: Zalo answered and refused for this message (bad data, bad recipient) — resending won't help.
 * - AUTHENTICATION_REQUIRED: access/refresh token rejected — an operator must re-authorize the OA.
 * - CONFIGURATION_REQUIRED: OA/app/template/billing/permission problem — fix config, then retry manually.
 * - UNKNOWN_OUTCOME: the request may have been processed (timeout after sending, 504, malformed 2xx).
 *   Never resent automatically — ZBS messages are paid and tracking_id is not an idempotency key.
 */
export type ZbsErrorClass =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'AUTHENTICATION_REQUIRED'
  | 'CONFIGURATION_REQUIRED'
  | 'UNKNOWN_OUTCOME';

/**
 * Provider error codes (docs.zaloplatforms.com/docs/ZBS/bang-ma-loi, verified 2026-10-18)
 * grouped by how the worker reacts. Codes not listed fall back to NON_RETRYABLE.
 */
export const ZBS_ACCESS_TOKEN_INVALID = -124;

export const ZBS_RETRYABLE_CODES = new Set<number>([
  -100, // Unknown error — "vui lòng thử lại sau"
]);

/** "Not allowed to send at night 22h–7h (VN time)" — deferred to the next morning. */
export const ZBS_NIGHT_RESTRICTION_CODE = -133;

export const ZBS_INVALID_RECIPIENT_CODES = new Set<number>([
  -108, // Phone number invalid
]);

export const ZBS_INELIGIBLE_RECIPIENT_CODES = new Set<number>([
  -110, // Zalo app version unsupported
  -118, // Zalo account not existed / disabled
  -139, // User refused this template type
  -140, // User not eligible under current delivery policy
  -141, // User refused phone messages from this OA
]);

export const ZBS_CONFIGURATION_CODES = new Set<number>([
  -101, // Application invalid
  -103, // Application not activated
  -104, // App secret key invalid
  -106, // Method unsupported
  -109, // Template ID invalid
  -115, // ZBS account balance insufficient
  -117, // OA/App has no permission on this template
  -120, // OA has not bought the service package
  -1202, // OA has no permission on media resources
  -1241, // Invalid appsecret_proof
  -125, // OA ID invalid
  -126, // Out of quota (development mode)
  -127, // Test template can only be sent to admins
  -131, // Template not approved
  -135, // OA has no phone-message permission (not verified / free plan)
  -1351, // OA blocked for violations
  -136, // ZBS Account association required
  -137, // ZBS Account charge failure
  -138, // App has no permission for this feature
  -1381, // Extension has no permission on the OA's ZBS Account
  -144, // OA daily phone-message quota exceeded
  -145, // OA may not send this template type
  -147, // Template daily quota exceeded
  -161, // sending_mode invalid
  -162, // Template type unsupported on this endpoint
]);

/** Codes that mean the configured template itself is unusable — further sends are paused
 * until the template is re-verified, so we don't keep hitting the API with it. */
export const ZBS_TEMPLATE_UNUSABLE_CODES = new Set<number>([-109, -117, -131]);

/** Short Vietnamese labels for the admin UI (codes from the official table). */
export const ZBS_ERROR_LABELS: Record<number, string> = {
  [-100]: 'Lỗi không xác định từ Zalo',
  [-101]: 'Ứng dụng gửi tin không hợp lệ',
  [-103]: 'Ứng dụng chưa được kích hoạt',
  [-104]: 'Secret key của ứng dụng không hợp lệ',
  [-108]: 'Số điện thoại không hợp lệ',
  [-109]: 'Template ID không hợp lệ',
  [-110]: 'Phiên bản Zalo của người nhận không hỗ trợ',
  [-111]: 'Template không có dữ liệu',
  [-1121]: 'Tham số vượt quá độ dài cho phép',
  [-1122]: 'Thiếu tham số template',
  [-1124]: 'Tham số sai định dạng',
  [-115]: 'Tài khoản ZBS không đủ số dư',
  [-116]: 'Nội dung tham số không hợp lệ',
  [-117]: 'OA/App không có quyền dùng template này',
  [-118]: 'Số điện thoại không có tài khoản Zalo (hoặc đã bị vô hiệu hóa)',
  [-120]: 'OA chưa mua gói dịch vụ',
  [-124]: 'Access token không hợp lệ',
  [-125]: 'OA ID không hợp lệ',
  [-126]: 'Ví development mode không đủ số dư',
  [-127]: 'Template test chỉ gửi được cho quản trị viên',
  [-131]: 'Template chưa được phê duyệt',
  [-132]: 'Tham số không hợp lệ',
  [-133]: 'Không được gửi loại tin này từ 22h đến 7h',
  [-135]: 'OA chưa có quyền gửi tin qua SĐT',
  [-1351]: 'OA bị chặn gửi tin SĐT do vi phạm',
  [-136]: 'Cần kết nối ZBS Account',
  [-137]: 'Thanh toán ZBS Account thất bại',
  [-138]: 'Ứng dụng chưa có quyền gửi tin SĐT',
  [-139]: 'Người dùng từ chối nhận loại tin này',
  [-140]: 'Người dùng không đủ điều kiện nhận tin theo chính sách',
  [-141]: 'Người dùng từ chối nhận tin SĐT từ OA',
  [-144]: 'OA đã hết hạn mức gửi tin SĐT trong ngày',
  [-145]: 'OA không được phép gửi loại nội dung này',
  [-147]: 'Template đã hết hạn mức gửi trong ngày',
  [-153]: 'Dữ liệu truyền vào sai quy định',
};
