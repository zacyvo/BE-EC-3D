import { isHoChiMinhCity } from '../orders/shipping-fee.util';
import { PromotionConditions, PromotionRegion } from './schemas/promotion.schema';

/**
 * Pure rules behind a program's `conditions` (see PromotionConditions). PromotionsService loads the
 * data (customer history, product categories) and calls these; each check returns a customer-facing
 * reason when the rule fails, or null when it holds (or is off).
 */

const DAY_MS = 86_400_000;
/** Vietnam has no DST — a fixed UTC+7 offset is exact. */
const VN_OFFSET_MS = 7 * 3_600_000;

export const WEEKDAY_LABELS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

/** What we know about the customer, for the customer-level rules. */
export interface CustomerPromoProfile {
  accountCreatedAt?: Date;
  dob?: Date;
  marketingOptIn: boolean;
  /** Orders that aren't cancelled (any status), for "đơn hàng đầu tiên" / "khách quay lại". */
  orderCount: number;
  lastOrderAt?: Date;
  /** DELIVERED orders. */
  completedOrders: number;
  /** Sum of DELIVERED orders' totals minus goods refunds of settled returns (VND). */
  totalSpent: number;
}

/** Cart line enriched with the product's category (for product/category scoped codes). */
export interface PromoCartLine {
  productId: string;
  categoryId?: string;
  quantity: number;
  subtotal: number;
}

/** What we know about the order being priced, for the order/time-level rules. */
export interface OrderPromoContext {
  now: Date;
  city?: string | null;
  paymentMethod?: string | null;
  /** Undefined when the caller didn't send the cart lines. */
  lines?: PromoCartLine[];
}

const vnd = (n: number) => `${n.toLocaleString('vi-VN')}₫`;
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/** Calendar parts of `d` in Vietnam time. */
export function vnParts(d: Date): { weekday: number; hour: number; month: number } {
  const v = new Date(d.getTime() + VN_OFFSET_MS);
  return { weekday: v.getUTCDay(), hour: v.getUTCHours(), month: v.getUTCMonth() };
}

const has = (n?: number | null): n is number => typeof n === 'number' && n > 0;
const hasList = <T>(l?: T[] | null): l is T[] => Array.isArray(l) && l.length > 0;
const hasHourWindow = (c: PromotionConditions) =>
  typeof c.hourFrom === 'number' && typeof c.hourTo === 'number' && c.hourFrom !== c.hourTo;

/** True when any rule needs the customer's order history / profile. */
export function needsCustomerProfile(c?: PromotionConditions | null): boolean {
  if (!c) return false;
  return (
    has(c.newAccountWithinDays) || !!c.firstOrderOnly || has(c.minCompletedOrders) ||
    has(c.maxCompletedOrders) || has(c.minTotalSpent) || !!c.birthdayMonthOnly ||
    has(c.inactiveDays) || !!c.marketingOptInOnly
  );
}

/** True when the discount only covers some products / categories. */
export function isScoped(c?: PromotionConditions | null): boolean {
  return !!c && (hasList(c.productIds) || hasList(c.categoryIds));
}

/** Customer-level rules ("who"). */
export function checkCustomerConditions(
  c: PromotionConditions | undefined | null,
  p: CustomerPromoProfile,
  now: Date,
): string | null {
  if (!c) return null;
  if (has(c.newAccountWithinDays)) {
    const created = p.accountCreatedAt?.getTime();
    if (!created || now.getTime() - created > c.newAccountWithinDays * DAY_MS) {
      return `Mã chỉ dành cho tài khoản mới đăng ký trong ${c.newAccountWithinDays} ngày`;
    }
  }
  if (c.firstOrderOnly && p.orderCount > 0) {
    return 'Mã chỉ áp dụng cho đơn hàng đầu tiên của bạn';
  }
  if (has(c.minCompletedOrders) && p.completedOrders < c.minCompletedOrders) {
    return `Mã dành cho khách đã có từ ${c.minCompletedOrders} đơn hàng thành công (bạn đang có ${p.completedOrders})`;
  }
  if (has(c.maxCompletedOrders) && p.completedOrders > c.maxCompletedOrders) {
    return `Mã dành cho khách có tối đa ${c.maxCompletedOrders} đơn hàng thành công`;
  }
  if (has(c.minTotalSpent) && p.totalSpent < c.minTotalSpent) {
    return `Mã dành cho khách có tổng chi tiêu từ ${vnd(c.minTotalSpent)} (bạn đang có ${vnd(p.totalSpent)})`;
  }
  if (c.birthdayMonthOnly) {
    if (!p.dob) return 'Mã sinh nhật: vui lòng cập nhật ngày sinh trong Hồ sơ';
    if (vnParts(p.dob).month !== vnParts(now).month) return 'Mã chỉ dùng được trong tháng sinh nhật của bạn';
  }
  if (has(c.inactiveDays)) {
    const last = p.lastOrderAt?.getTime();
    if (!p.completedOrders || !last) return 'Mã dành cho khách đã từng mua hàng quay lại';
    if (now.getTime() - last < c.inactiveDays * DAY_MS) {
      return `Mã dành cho khách quay lại sau ${c.inactiveDays} ngày chưa mua hàng`;
    }
  }
  if (c.marketingOptInOnly && !p.marketingOptIn) {
    return 'Mã dành cho khách đăng ký nhận tin khuyến mãi — bật trong Hồ sơ của bạn';
  }
  return null;
}

/** Time-level rules ("when"). */
export function checkTimeConditions(c: PromotionConditions | undefined | null, now: Date): string | null {
  if (!c) return null;
  const { weekday, hour } = vnParts(now);
  if (hasList(c.weekdays) && !c.weekdays.includes(weekday)) {
    return `Mã chỉ áp dụng vào ${[...c.weekdays].sort(sundayLast).map((d) => WEEKDAY_LABELS[d]).join(', ')}`;
  }
  if (hasHourWindow(c)) {
    const from = c.hourFrom as number;
    const to = c.hourTo as number;
    const inside = from < to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!inside) return `Mã chỉ áp dụng trong khung giờ ${hh(from)}–${hh(to)}`;
  }
  return null;
}

/** Order-level rules except the product scope ("what"): region, payment method, item count. */
export function checkOrderConditions(c: PromotionConditions | undefined | null, o: OrderPromoContext): string | null {
  if (!c) return null;
  if (c.region) {
    if (!o.city?.trim()) return 'Chọn địa chỉ giao hàng để áp dụng mã này';
    const hcm = isHoChiMinhCity(o.city);
    if (c.region === PromotionRegion.HCM && !hcm) return 'Mã chỉ áp dụng cho đơn giao tại TP. Hồ Chí Minh';
    if (c.region === PromotionRegion.OUTSIDE_HCM && hcm) return 'Mã chỉ áp dụng cho đơn giao ngoài TP. Hồ Chí Minh';
  }
  if (hasList(c.paymentMethods) && !c.paymentMethods.includes((o.paymentMethod ?? '') as never)) {
    return `Mã chỉ áp dụng khi thanh toán ${c.paymentMethods.map(paymentLabel).join(' hoặc ')}`;
  }
  if (has(c.minItemQuantity)) {
    if (!o.lines) return 'Không xác định được số lượng sản phẩm — vui lòng tải lại trang';
    const qty = o.lines.reduce((s, l) => s + l.quantity, 0);
    if (qty < c.minItemQuantity) return `Mua tối thiểu ${c.minItemQuantity} sản phẩm để dùng mã này (đang có ${qty})`;
  }
  return null;
}

/** Subtotal of the lines a scoped code covers (the whole goods total when it isn't scoped). */
export function eligibleSubtotal(
  c: PromotionConditions | undefined | null,
  lines: PromoCartLine[] | undefined,
  orderTotal: number,
): { amount: number; reason: string | null } {
  if (!isScoped(c)) return { amount: orderTotal, reason: null };
  if (!lines) return { amount: 0, reason: 'Không xác định được sản phẩm trong giỏ — vui lòng tải lại trang' };
  const products = new Set((c!.productIds ?? []).map(String));
  const categories = new Set((c!.categoryIds ?? []).map(String));
  const amount = lines
    .filter((l) => products.has(l.productId) || (!!l.categoryId && categories.has(l.categoryId)))
    .reduce((s, l) => s + l.subtotal, 0);
  if (amount <= 0) return { amount: 0, reason: 'Giỏ hàng chưa có sản phẩm thuộc chương trình của mã này' };
  return { amount, reason: null };
}

export function paymentLabel(m: string): string {
  return m === 'BANK_TRANSFER' ? 'chuyển khoản' : m === 'COD' ? 'khi nhận hàng (COD)' : m;
}

const sundayLast = (a: number, b: number) => ((a + 6) % 7) - ((b + 6) % 7);

/**
 * Short customer-facing lines describing the rules ("Đơn hàng đầu tiên", "Thứ 6, Thứ 7",
 * "20:00–22:00"…), shown under the code at checkout. `categoryNames` names the scoped categories.
 */
export function describeConditions(
  c: PromotionConditions | undefined | null,
  opts: { exclusive?: boolean; categoryNames?: string[] } = {},
): string[] {
  const out: string[] = [];
  if (c) {
    if (has(c.newAccountWithinDays)) out.push(`Thành viên mới (đăng ký trong ${c.newAccountWithinDays} ngày)`);
    if (c.firstOrderOnly) out.push('Đơn hàng đầu tiên');
    if (has(c.minCompletedOrders)) out.push(`Từ ${c.minCompletedOrders} đơn hàng thành công`);
    if (has(c.maxCompletedOrders)) out.push(`Tối đa ${c.maxCompletedOrders} đơn hàng thành công`);
    if (has(c.minTotalSpent)) out.push(`Tổng chi tiêu từ ${vnd(c.minTotalSpent)}`);
    if (c.birthdayMonthOnly) out.push('Trong tháng sinh nhật');
    if (has(c.inactiveDays)) out.push(`Khách quay lại sau ${c.inactiveDays} ngày`);
    if (c.marketingOptInOnly) out.push('Khách đăng ký nhận tin');
    if (has(c.minItemQuantity)) out.push(`Mua từ ${c.minItemQuantity} sản phẩm`);
    if (isScoped(c)) {
      out.push(
        opts.categoryNames?.length && !hasList(c.productIds)
          ? `Áp dụng cho: ${opts.categoryNames.join(', ')}`
          : 'Áp dụng cho một số sản phẩm',
      );
    }
    if (c.region === PromotionRegion.HCM) out.push('Giao tại TP.HCM');
    if (c.region === PromotionRegion.OUTSIDE_HCM) out.push('Giao ngoài TP.HCM');
    if (hasList(c.paymentMethods)) out.push(`Thanh toán ${c.paymentMethods.map(paymentLabel).join(' / ')}`);
    if (hasList(c.weekdays)) out.push([...c.weekdays].sort(sundayLast).map((d) => WEEKDAY_LABELS[d]).join(', '));
    if (hasHourWindow(c)) out.push(`Khung giờ ${hh(c.hourFrom as number)}–${hh(c.hourTo as number)}`);
  }
  if (opts.exclusive) out.push('Không dùng chung mã khác');
  return out;
}

/** Drop rules that are off (0 / false / empty) so stored conditions stay minimal. */
export function compactConditions<T extends object>(c: T | undefined | null): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c ?? {})) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    // Hours: 0 is a real value (midnight); every other numeric rule uses 0 = off.
    if (typeof v === 'number' && v === 0 && k !== 'hourFrom' && k !== 'hourTo') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
