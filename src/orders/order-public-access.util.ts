import * as crypto from 'crypto';

/**
 * "Link xem đơn" — lets the customer of an admin-created order (often a guest account with no
 * password, so they can't log in) open that one order with: secret link + phone + security code.
 * Same model as the contract public link (contracts/public/:token). See docs/ORDER_PUBLIC_ACCESS.md.
 */

/** No look-alike characters (0/O, 1/I). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ORDER_ACCESS_CODE_LENGTH = 8;
export const ORDER_ACCESS_MAX_ATTEMPTS = 5;
export const ORDER_ACCESS_LOCK_MINUTES = 15;
export const ORDER_ACCESS_JWT_TYPE = 'order-access';
export const ORDER_ACCESS_JWT_TTL = '4h';

export function genOrderAccessToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function genOrderAccessCode(): string {
  let code = '';
  for (let i = 0; i < ORDER_ACCESS_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** "+84 912.345.678" / "84912345678" / "0912 345 678" → "0912345678". */
export function normalizeAccessPhone(phone: string | undefined | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11) return '0' + digits.slice(2);
  return digits;
}

/** A real (unmasked) VN phone — marketplace imports carry masked strings like "*****678". */
export function isUsableAccessPhone(phone: string | undefined | null): boolean {
  return /^0\d{9}$/.test(normalizeAccessPhone(phone)) && !(phone ?? '').includes('*');
}

export function maskAccessPhone(phone: string): string {
  if (phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-3);
}

export function normalizeAccessCode(code: string | undefined | null): string {
  return (code ?? '').replace(/\s/g, '').toUpperCase();
}

/** Constant-time compare (lengths may differ → false without leaking where). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Short display code of an order — same as the storefront / admin "#XXXXXXXX". */
export function orderShortCode(orderId: string): string {
  return orderId.slice(-8).toUpperCase();
}

export function orderPublicUrl(frontendUrl: string, token: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/order/${token}`;
}
