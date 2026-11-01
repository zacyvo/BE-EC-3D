import { OrderRef } from '../payments/payment-confirmation.service';

/**
 * Deterministic parser for the admin payment command (no AI/NLP):
 *
 *   Đơn hàng: LG6A1B2C3D
 *   Đã thanh toán
 *
 * Case, extra whitespace, Vietnamese accents ("Don hang" / "da thanh toan"), an optional ":" / "-"
 * / "#" and putting both parts on one line are tolerated. The order may be given as its payment
 * reference (LG…), the admin display code (#6A1B2C3D) or the full 24-char id. Anything with more
 * than one code, extra words, or a different action is rejected — never guessed.
 */
export type PaymentCommand =
  /** Not an attempt at the command — the Bot keeps its normal (silent) behavior. */
  | { kind: 'NOT_COMMAND' }
  /** Looks like the command but can't be trusted as one — reply with the expected format. */
  | { kind: 'INVALID'; reason: 'MULTIPLE_ORDERS' | 'BAD_ORDER_CODE' | 'BAD_FORMAT' }
  | { kind: 'CONFIRM_PAYMENT'; orderRef: OrderRef };

export const PAYMENT_COMMAND_HELP =
  'Lệnh xác nhận thanh toán chưa đúng định dạng. Vui lòng gửi đúng 2 dòng:\nĐơn hàng: LGxxxxxxxx\nĐã thanh toán';

const MAX_COMMAND_LENGTH = 200;

/** Lowercase, accents removed ("Đã" → "da"), whitespace collapsed per line. */
export function normalizeVietnamese(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const ORDER_PART = /(?:^|\n|\s)don hang\b/;
const PAID_PART = /\bda thanh toan\b/;
const STRICT = /^don hang ?[:\-]? ?#? ?([a-z0-9]+)[ \n]?[,.;]? ?\n?da thanh toan ?[.!]?$/;

function toOrderRef(token: string): OrderRef | null {
  const t = token.toUpperCase();
  if (/^LG[0-9A-F]{8,22}$/.test(t)) return { kind: 'REFERENCE', value: t };
  if (/^[0-9A-F]{24}$/.test(t)) return { kind: 'OBJECT_ID', value: t };
  if (/^[0-9A-F]{8}$/.test(t)) return { kind: 'DISPLAY_CODE', value: t };
  return null;
}

export function parsePaymentCommand(raw: string | undefined | null): PaymentCommand {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'NOT_COMMAND' };
  const text = normalizeVietnamese(raw.slice(0, MAX_COMMAND_LENGTH * 2));
  const mentionsOrder = ORDER_PART.test(text);
  const mentionsPaid = PAID_PART.test(text);
  // Only text that starts like the command, or names both parts, counts as an attempt.
  if (!(text.startsWith('don hang') || (mentionsOrder && mentionsPaid))) return { kind: 'NOT_COMMAND' };
  if (raw.length > MAX_COMMAND_LENGTH) return { kind: 'INVALID', reason: 'BAD_FORMAT' };

  // Several codes ("Đơn hàng: LG1, LG2", two "Đơn hàng" lines) are rejected explicitly.
  const codeLike = text.match(/\b(?:lg[0-9a-f]{8,22}|[0-9a-f]{24}|[0-9a-f]{8})\b/g) ?? [];
  if ((text.match(/don hang/g) ?? []).length > 1 || new Set(codeLike).size > 1) {
    return { kind: 'INVALID', reason: 'MULTIPLE_ORDERS' };
  }

  const m = STRICT.exec(text);
  if (!m) return { kind: 'INVALID', reason: 'BAD_FORMAT' };
  const orderRef = toOrderRef(m[1]);
  if (!orderRef) return { kind: 'INVALID', reason: 'BAD_ORDER_CODE' };
  return { kind: 'CONFIRM_PAYMENT', orderRef };
}

/** Read-only admin commands (same allowlist as the payment command). */
export type InfoCommand = 'LIST_PENDING' | 'HELP';

const LIST_PENDING_PATTERN =
  /^(ds|list|danh sach( don)?( cho)?( xac nhan)?( thanh toan)?|(don )?cho (xac nhan )?thanh toan|(don )?cho xac nhan( thanh toan)?)$/;
const HELP_PATTERN = /^(help|start|tro giup|huong dan|lenh|menu|\?)$/;

/** "Danh sách", "DS", "Đơn chờ thanh toán", "/list" … → LIST_PENDING; "Hướng dẫn", "/help" … → HELP. */
export function parseInfoCommand(raw: string | undefined | null): InfoCommand | null {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  const text = normalizeVietnamese(raw)
    .replace(/^\//, '')
    .replace(/[.!:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '?') return 'HELP';
  if (LIST_PENDING_PATTERN.test(text)) return 'LIST_PENDING';
  if (HELP_PATTERN.test(text)) return 'HELP';
  return null;
}
