import { OrderStatus } from './schemas/order.schema';

/** VAT rate on the invoice. Listed prices already include it — the customer pays nothing extra. */
export const EINVOICE_VAT_RATE = 10;

/** The request doesn't change the amount to pay, so it is accepted on any order that isn't
 * cancelled — the shop handles it separately from shipping. */
export const EINVOICE_REQUESTABLE_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/** Orders requested before 2026-11-02 had the VAT added on top (Order.vatAmount > 0): while such a
 * request awaits the shop's decision the order can't move to these statuses (the COD amount
 * isn't final yet). */
export const EINVOICE_PENDING_BLOCKED_STATUSES = [OrderStatus.SHIPPED, OrderStatus.DELIVERED];

export interface OrderVatInput {
  items: Array<{ productName: string; quantity: number; unitPrice: number; subtotal: number; color?: string; size?: string }>;
  discountAmount?: number;
  shippingFee?: number;
}

/** One invoice line — same arithmetic as EInvoiceService.computeItems (total = gross − discount,
 * VAT rounded per line), so the order's VAT always equals the issued invoice's VAT. */
export interface OrderVatLine {
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  total: number;
  vatAmount: number;
}

/** Largest price before VAT whose total with VAT (rounded like EInvoiceService.computeItems) is
 * at most `gross`. VAT rounding skips some amounts (at 10%: 467 999 → 468 001đ), so the result
 * can fall 1đ short — the caller carries that over to the next line. */
function netOfGross(gross: number, vatRate: number): number {
  let net = Math.round((gross * 100) / (100 + vatRate)) + 1;
  while (net > 0 && net + Math.round((net * vatRate) / 100) > gross) net--;
  return net;
}

/** Unit price before VAT such that round(quantity × price − discount) is exactly `netTotal` —
 * a whole number when possible, otherwise with as few decimals as needed. */
function netUnitPrice(netTotal: number, netDiscount: number, quantity: number): number {
  const exact = (netTotal + netDiscount) / quantity;
  for (const digits of [0, 2, 4]) {
    const f = 10 ** digits;
    const price = Math.round(exact * f) / f;
    if (Math.round(quantity * price - netDiscount) === netTotal) return price;
  }
  return exact;
}

/** Splits the order into invoice lines: the order discount is prorated over the product lines
 * (last line takes the remainder) and the shipping fee, if any, is its own line.
 *
 * `pricesIncludeVat` (the default — listed prices include VAT): each line's price and discount are
 * converted to before-VAT amounts, so the invoice total equals what the customer pays (a 1đ
 * rounding gap moves on to the next line; only a gap on the last line leaves the invoice 1đ
 * under the amount paid). Without
 * it the order amounts are taken as before-VAT and the VAT comes on top (orders requested before
 * 2026-11-02, Order.vatAmount > 0). */
export function computeOrderVat(
  order: OrderVatInput,
  vatRate = EINVOICE_VAT_RATE,
  { pricesIncludeVat = true }: { pricesIncludeVat?: boolean } = {},
) {
  const items = order.items ?? [];
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const discount = Math.min(Math.max(0, order.discountAmount ?? 0), subtotal);

  let carry = 0;
  const invoiceAmounts = (quantity: number, unitPrice: number, discountAmount: number) => {
    if (!pricesIncludeVat) {
      const total = quantity * unitPrice - discountAmount;
      return { quantity, unitPrice, discountAmount, total, vatAmount: Math.round((total * vatRate) / 100) };
    }
    const gross = quantity * unitPrice - discountAmount + carry;
    const total = netOfGross(gross, vatRate);
    carry = gross - total - Math.round((total * vatRate) / 100);
    const netDiscount = Math.round((discountAmount * 100) / (100 + vatRate));
    return {
      quantity,
      unitPrice: netUnitPrice(total, netDiscount, quantity),
      discountAmount: netDiscount,
      total,
      vatAmount: Math.round((total * vatRate) / 100),
    };
  };

  let discountLeft = discount;
  const lines: OrderVatLine[] = items.map((item, idx) => {
    const isLast = idx === items.length - 1;
    const share = isLast ? discountLeft : subtotal > 0 ? Math.round((discount * item.subtotal) / subtotal) : 0;
    const lineDiscount = Math.min(share, item.subtotal, discountLeft);
    discountLeft -= lineDiscount;
    const variant = [item.color, item.size].filter(Boolean).join(', ');
    return {
      name: variant ? `${item.productName} (${variant})` : item.productName,
      unit: 'Cái',
      ...invoiceAmounts(item.quantity, item.unitPrice, lineDiscount),
    };
  });

  const shippingFee = Math.max(0, order.shippingFee ?? 0);
  if (shippingFee > 0) {
    lines.push({ name: 'Phí vận chuyển', unit: 'Lần', ...invoiceAmounts(1, shippingFee, 0) });
  }

  return {
    lines,
    totalBeforeTax: lines.reduce((s, l) => s + l.total, 0),
    vatAmount: lines.reduce((s, l) => s + l.vatAmount, 0),
  };
}
