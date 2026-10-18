/**
 * Vietnamese mobile number → the format the ZBS send API expects ("chuẩn hóa theo mã quốc
 * gia": 0987654321 → 84987654321). Same carrier prefixes as checkout's VN_MOBILE_REGEX
 * (orders/dto/order.dto.ts) — keep both in sync.
 */
const VN_MOBILE_NATIONAL = /^(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/;

export type PhoneNormalization =
  | { ok: true; phone: string }
  | { ok: false; reason: 'MISSING' | 'MASKED' | 'MALFORMED' | 'UNSUPPORTED_PREFIX' };

/** Accepts 0987654321, 84987654321, +84987654321, 0084987654321, with spaces / dots /
 * dashes / parentheses. Never guesses: anything else is rejected. */
export function normalizeVnPhone(raw: string | undefined | null): PhoneNormalization {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: 'MISSING' };
  // Masked marketplace numbers (e.g. "(+84)******123") must never be "repaired".
  if (/[*xX]/.test(input)) return { ok: false, reason: 'MASKED' };
  if (!/^[+\d\s.\-()]+$/.test(input)) return { ok: false, reason: 'MALFORMED' };

  const plus = input.startsWith('+');
  const digits = input.replace(/\D/g, '');
  let national: string;
  if (plus) {
    if (!digits.startsWith('84')) return { ok: false, reason: 'UNSUPPORTED_PREFIX' };
    national = digits.slice(2);
  } else if (digits.startsWith('0084')) {
    national = digits.slice(4);
  } else if (digits.startsWith('84') && digits.length === 11) {
    national = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 10) {
    national = digits.slice(1);
  } else {
    return { ok: false, reason: 'MALFORMED' };
  }
  // "+84 0987…" style (trunk zero kept after the country code).
  if (national.length === 10 && national.startsWith('0')) national = national.slice(1);
  if (national.length !== 9) return { ok: false, reason: 'MALFORMED' };
  if (!VN_MOBILE_NATIONAL.test(national)) return { ok: false, reason: 'UNSUPPORTED_PREFIX' };
  return { ok: true, phone: `84${national}` };
}

/** 84987654321 → 849******21 — for logs and the admin API (never log a full number). */
export function maskZbsPhone(phone: string | undefined | null): string {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '—';
  if (d.length < 7) return '*'.repeat(d.length);
  return `${d.slice(0, 3)}${'*'.repeat(d.length - 5)}${d.slice(-2)}`;
}
