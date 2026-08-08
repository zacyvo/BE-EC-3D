/**
 * Danh sách icon social/liên hệ được phép chọn cho mỗi link trong NFC profile.
 * Trùng khớp với catalog phía frontend (frontend-user & frontend-admin `lib/social-icons.ts`)
 * — icon key là hợp đồng (contract) giữa BE/FE, đổi ở đây phải đổi cả 2 FE.
 */
export const SOCIAL_ICON_KEYS = [
  'phone',
  'email',
  'website',
  'facebook',
  'messenger',
  'zalo',
  'instagram',
  'threads',
  'tiktok',
  'x',
  'youtube',
  'linkedin',
  'whatsapp',
  'telegram',
  'snapchat',
  'pinterest',
  'discord',
  'wechat',
  'line',
  'skype',
  'viber',
  'reddit',
] as const;

export type SocialIconKey = (typeof SOCIAL_ICON_KEYS)[number];

export type IconInputKind = 'phone' | 'email' | 'text';

/** Loại giá trị mỗi icon nhận — dùng để validate `value` khi lưu link. */
export const ICON_INPUT_KIND: Record<SocialIconKey, IconInputKind> = {
  phone: 'phone',
  zalo: 'phone',
  whatsapp: 'phone',
  viber: 'phone',
  email: 'email',
  website: 'text',
  facebook: 'text',
  messenger: 'text',
  instagram: 'text',
  threads: 'text',
  tiktok: 'text',
  x: 'text',
  youtube: 'text',
  linkedin: 'text',
  telegram: 'text',
  snapchat: 'text',
  pinterest: 'text',
  discord: 'text',
  wechat: 'text',
  line: 'text',
  skype: 'text',
  reddit: 'text',
};

const VN_OR_INTL_PHONE = /^\+?[0-9]{8,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate `value` theo loại icon đã chọn. Trả về lỗi (string) hoặc null nếu hợp lệ. */
export function validateLinkValue(icon: SocialIconKey, rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) return 'Giá trị không được để trống';
  if (value.length > 300) return 'Giá trị quá dài (tối đa 300 ký tự)';

  const kind = ICON_INPUT_KIND[icon];
  if (kind === 'phone' && !VN_OR_INTL_PHONE.test(value.replace(/[\s-]/g, ''))) {
    return 'Số điện thoại không hợp lệ';
  }
  if (kind === 'email' && !EMAIL_RE.test(value)) {
    return 'Email không hợp lệ';
  }
  return null;
}
