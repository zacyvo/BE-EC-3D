import * as XLSX from 'xlsx';
import { OrderStatus } from '../orders/schemas/order.schema';
import { VN_MOBILE_REGEX } from '../orders/dto/order.dto';
import { ShopeeSyncException } from './shopee-sync.exceptions';
import { ShopeeSyncErrorCode } from './shopee-sync.constants';

/**
 * Pure, DB-free parsing/matching logic for Shopee's bulk order-list Excel exports —
 * kept separate from ShopeeOrderSyncService so it is unit-testable without Mongoose.
 *
 * Column headers below are verified verbatim against real Shopee exports — both
 * `Order.toship.<range>.xlsx` (orders awaiting handover) and
 * `Order.completed.<range>.xlsx` (finished orders) use the exact same "orders"
 * sheet/column layout, only the row *contents* differ — so this module handles
 * any Shopee order-list report generically rather than special-casing a filename.
 * Do not "clean up" the Vietnamese header strings, Shopee's own template is
 * inconsistent (e.g. two columns differ only by the capitalization of
 * "người"/"Người").
 */
export const SHOPEE_ORDER_COLUMNS = {
  orderCode: 'Mã đơn hàng',
  packageCode: 'Mã Kiện Hàng',
  orderDate: 'Ngày đặt hàng',
  status: 'Trạng Thái Đơn Hàng',
  /** Separate from `status` above — only populated when a return/refund is actually
   * in progress for this order. More reliable than keyword-parsing `status` text,
   * which can also just *mention* "Trả hàng/Hoàn tiền" as a future option (e.g. the
   * post-delivery grace-period message) without an active return existing. */
  returnStatus: 'Trạng thái Trả hàng/Hoàn tiền',
  buyerComment: 'Nhận xét từ Người mua',
  trackingCode: 'Mã vận đơn',
  carrierName: 'Đơn Vị Vận Chuyển',
  estimatedDeliveryDate: 'Ngày giao hàng dự kiến',
  productSku: 'SKU sản phẩm',
  productName: 'Tên sản phẩm',
  variantSku: 'SKU phân loại hàng',
  variantName: 'Tên phân loại hàng',
  offerPrice: 'Giá ưu đãi',
  quantity: 'Số lượng',
  /** Per-LINE amount paid (capital "Người") — NOT the same column as orderTotalPaid. */
  lineTotalPaid: 'Tổng số tiền Người mua thanh toán',
  shippingFeePaidByBuyer: 'Phí vận chuyển mà người mua trả',
  /** Whole-ORDER grand total paid (lowercase "người") — repeated on every row of the order. */
  orderTotalPaid: 'Tổng số tiền người mua thanh toán',
  buyerUsername: 'Người Mua',
  recipientName: 'Tên Người nhận',
  phone: 'Số điện thoại',
  province: 'Tỉnh/Thành phố',
  /** Legacy label; holds the ward/commune name under the post-2025 2-tier address system. */
  wardLegacyLabel: 'TP / Quận / Huyện',
  district: 'Quận',
  address: 'Địa chỉ nhận hàng',
  note: 'Ghi chú',
} as const;

const REQUIRED_COLUMNS: string[] = [
  SHOPEE_ORDER_COLUMNS.orderCode,
  SHOPEE_ORDER_COLUMNS.status,
  SHOPEE_ORDER_COLUMNS.productName,
  SHOPEE_ORDER_COLUMNS.quantity,
  SHOPEE_ORDER_COLUMNS.offerPrice,
  SHOPEE_ORDER_COLUMNS.recipientName,
  SHOPEE_ORDER_COLUMNS.phone,
  SHOPEE_ORDER_COLUMNS.address,
  SHOPEE_ORDER_COLUMNS.province,
  SHOPEE_ORDER_COLUMNS.wardLegacyLabel,
  SHOPEE_ORDER_COLUMNS.buyerUsername,
];

export type ShopeeOrderRawRow = Record<string, string>;

/** Parses the uploaded buffer into raw rows keyed by Shopee's own header text. */
export function parseShopeeOrderWorkbook(buffer: Buffer): ShopeeOrderRawRow[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw new ShopeeSyncException(
      ShopeeSyncErrorCode.ORDER_FILE_INVALID_FORMAT,
      'Không đọc được file — vui lòng chọn đúng file Excel (.xlsx) danh sách đơn hàng xuất từ Shopee Seller Center (mục Đơn hàng, ví dụ tab "Cần giao"/"Hoàn thành" > Xuất file)',
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_FILE_EMPTY, 'File Excel không có sheet dữ liệu nào');
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  });
  if (rawRows.length === 0) {
    throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_FILE_EMPTY, 'File không có dữ liệu đơn hàng nào');
  }

  // Real-world gotcha (verified against a re-saved Order.completed export): cells can
  // have INCONSISTENT Unicode normalization per-cell — some header/value text was
  // NFD/partially-decomposed (e.g. "á" as "a"+combining-acute) while sibling cells in
  // the same row stayed NFC, despite being visually identical on screen. Byte-exact
  // comparisons (Set.has(), String.includes()) against this module's NFC-authored
  // constants/keywords would silently fail without this normalization pass.
  const rows: ShopeeOrderRawRow[] = rawRows.map((raw) => {
    const normalized: ShopeeOrderRawRow = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key.normalize('NFC')] = typeof value === 'string' ? value.normalize('NFC') : value;
    }
    return normalized;
  });

  const headerSet = new Set(Object.keys(rows[0]));
  const missing = REQUIRED_COLUMNS.filter((c) => !headerSet.has(c));
  if (missing.length > 0) {
    throw new ShopeeSyncException(
      ShopeeSyncErrorCode.ORDER_FILE_INVALID_FORMAT,
      `File không đúng định dạng xuất đơn hàng Shopee (thiếu cột: ${missing.join(', ')})`,
    );
  }

  return rows;
}

/** Groups rows by "Mã đơn hàng" — a multi-item order spans multiple rows in Shopee's
 * export, one per product line. Preserves file order. */
export function groupRowsByOrderCode(rows: ShopeeOrderRawRow[]): Map<string, ShopeeOrderRawRow[]> {
  const map = new Map<string, ShopeeOrderRawRow[]>();
  for (const row of rows) {
    const code = (row[SHOPEE_ORDER_COLUMNS.orderCode] || '').trim();
    if (!code) continue;
    const existing = map.get(code);
    if (existing) existing.push(row);
    else map.set(code, [row]);
  }
  return map;
}

/** Shopee formats VND amounts as plain decimal strings, e.g. "17000.00". */
export function parseVndAmount(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function parseShopeeDate(raw: string | undefined): Date | undefined {
  if (!raw || !raw.trim()) return undefined;
  const date = new Date(raw.trim().replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Keyword-based status classifier, most-specific/highest-priority first.
 * Our OrderStatus enum has no RETURNED value, so refunds/returns map to CANCELLED.
 * Unrecognized text falls back to PROCESSING (safer default for rows sourced from
 * an active "to ship" export than silently defaulting to PENDING or DELIVERED).
 *
 * `returnStatus` (the dedicated "Trạng thái Trả hàng/Hoàn tiền" column) is checked
 * FIRST and, if non-empty, always wins — it's a real active return/refund, unlike
 * `rawStatus` which can just *mention* "Trả hàng/Hoàn tiền" as a still-available
 * option (real example: "Người mua xác nhận đã nhận được hàng, tuy nhiên Người
 * mua vẫn có thể gửi yêu cầu Trả hàng/Hoàn tiền tới ngày ..." — this is a
 * DELIVERED order, not a cancelled one, even though it contains those words).
 * Assumption not yet verified against a real populated `returnStatus` value: any
 * non-empty value is treated as an active return (no "request rejected" case
 * seen yet — revisit if that turns out to be common).
 */
export function mapShopeeOrderStatus(rawStatus: string, returnStatus?: string): OrderStatus {
  if ((returnStatus || '').trim()) return OrderStatus.CANCELLED;

  const s = (rawStatus || '').toLowerCase();
  if (s.includes('hủy')) return OrderStatus.CANCELLED;
  if (
    s.includes('xác nhận đã nhận được hàng') ||
    s.includes('hoàn thành') ||
    s.includes('giao thành công') ||
    s.includes('đã giao')
  ) {
    return OrderStatus.DELIVERED;
  }
  if (s.includes('hoàn tiền') || s.includes('trả hàng')) return OrderStatus.CANCELLED;
  if (s.includes('đang giao') || s.includes('vận chuyển') || s.includes('đã lấy hàng')) return OrderStatus.SHIPPED;
  if (s.includes('chờ giao hàng') || s.includes('chờ lấy hàng') || s.includes('đang xử lý') || s.includes('đang chuẩn bị')) {
    return OrderStatus.PROCESSING;
  }
  if (s.includes('chờ xác nhận')) return OrderStatus.PENDING;
  return OrderStatus.PROCESSING;
}

export function isMasked(value: string): boolean {
  return value.includes('*');
}

export function isValidVnMobile(phone: string): boolean {
  return VN_MOBILE_REGEX.test(phone.trim());
}

/** "0912345678" / "+84912345678" -> "0912345678", matching UsersService's convention. */
export function normalizeVnPhone(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith('+84') ? '0' + trimmed.slice(3) : trimmed;
}

export interface ShopeeShippingPreview {
  recipientName: string;
  phone: string;
  street: string;
  ward: string;
  district: string;
  city: string;
  note?: string;
}

/** Recipient/shipping fields are per-order (repeated identically on every line row),
 * so only the first row of the group is read. Values are used as-is — Shopee masks
 * name/phone/address for privacy in this export type, and there is no way to
 * recover the unmasked value from the file itself. */
export function buildShippingPreviewFromGroup(rows: ShopeeOrderRawRow[]): ShopeeShippingPreview {
  const row = rows[0];
  const note = [row[SHOPEE_ORDER_COLUMNS.note], row[SHOPEE_ORDER_COLUMNS.buyerComment]]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  return {
    recipientName: (row[SHOPEE_ORDER_COLUMNS.recipientName] || '').trim(),
    phone: (row[SHOPEE_ORDER_COLUMNS.phone] || '').trim(),
    street: (row[SHOPEE_ORDER_COLUMNS.address] || '').trim(),
    ward: (row[SHOPEE_ORDER_COLUMNS.wardLegacyLabel] || '').trim(),
    district: (row[SHOPEE_ORDER_COLUMNS.district] || '').trim(),
    city: (row[SHOPEE_ORDER_COLUMNS.province] || '').trim(),
    ...(note.length ? { note: note.join(' — ') } : {}),
  };
}

export interface ShopeeOrderMoney {
  subtotal: number;
  shippingFee: number;
  discountAmount: number;
  total: number;
}

/**
 * Reconciles Shopee's many money columns into the 4 fields Order needs, guaranteeing
 * the schema invariant `total = subtotal - discountAmount + shippingFee`:
 * - subtotal = sum of each line's (Giá ưu đãi × Số lượng)
 * - shippingFee = what the buyer paid for shipping (order-level, same on every row)
 * - total = the order's actual grand total paid (ground truth, order-level)
 * - discountAmount = backed out so the invariant holds exactly
 */
export function computeOrderMoney(rows: ShopeeOrderRawRow[]): ShopeeOrderMoney {
  const subtotal = rows.reduce((sum, row) => {
    const unitPrice = parseVndAmount(row[SHOPEE_ORDER_COLUMNS.offerPrice]);
    const qty = parseVndAmount(row[SHOPEE_ORDER_COLUMNS.quantity]);
    return sum + unitPrice * qty;
  }, 0);
  const shippingFee = parseVndAmount(rows[0][SHOPEE_ORDER_COLUMNS.shippingFeePaidByBuyer]);
  const total = parseVndAmount(rows[0][SHOPEE_ORDER_COLUMNS.orderTotalPaid]) || subtotal + shippingFee;
  const discountAmount = Math.max(0, subtotal + shippingFee - total);
  return { subtotal, shippingFee, discountAmount, total };
}

// ─── Product name matching (no SKU available in this export type) ────────────────

/** Vietnamese "đ/Đ" don't decompose via NFD, so they're normalized explicitly. */
export function stripDiacritics(input: string): string {
  return input
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeNameForMatch(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.length ? normalized.split(' ') : [];
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ProductMatchCandidate {
  productId: string;
  name: string;
  score: number;
}

/** Only an exact (normalized) name match is considered confident enough to
 * auto-link — anything below this always requires staff confirmation. */
export const AUTO_MATCH_SCORE = 1;

export function findBestProductMatches(
  rawProductName: string,
  products: { id: string; name: string }[],
  limit = 3,
): ProductMatchCandidate[] {
  const targetNormalized = normalizeNameForMatch(rawProductName);
  const targetTokens = tokenize(targetNormalized);
  const scored = products.map((p) => {
    const candidateNormalized = normalizeNameForMatch(p.name);
    const score = candidateNormalized === targetNormalized ? 1 : jaccardSimilarity(targetTokens, tokenize(candidateNormalized));
    return { productId: p.id, name: p.name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Best-effort match of Shopee's free-text variant label (e.g. "1 ô", "Bạc") against
 * the product's configured colors/sizes. Returns {} if nothing confidently matches —
 * callers should fall back to storing the raw label as an item note rather than
 * blocking the sync (this shop's Shopee variants are often custom/personalization
 * labels that don't correspond to a catalog color/size at all). */
export function matchVariantToColorOrSize(
  variantLabel: string,
  colors: { name: string }[],
  sizes: string[],
): { color?: string; size?: string } {
  if (!variantLabel?.trim()) return {};
  const normalized = normalizeNameForMatch(variantLabel);
  const color = colors.find((c) => normalizeNameForMatch(c.name) === normalized);
  if (color) return { color: color.name };
  const size = sizes.find((s) => normalizeNameForMatch(s) === normalized);
  if (size) return { size };
  return {};
}
