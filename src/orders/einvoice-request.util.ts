import { OrderStatus } from './schemas/order.schema';

/** VAT the customer pays on top when they ask for a VAT e-invoice ("+10% VAT"). */
export const EINVOICE_VAT_RATE = 10;

/** The VAT changes what the carrier collects (COD), so a request is only accepted before the
 * parcel leaves the shop. */
export const EINVOICE_REQUESTABLE_STATUSES = [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING];

/** While a request awaits the shop's decision the order can't move to these statuses (the COD
 * amount isn't final yet). */
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

/** Splits the order into invoice lines: the order discount is prorated over the product lines
 * (last line takes the remainder) and the shipping fee, if any, is its own line. */
export function computeOrderVat(order: OrderVatInput, vatRate = EINVOICE_VAT_RATE) {
  const items = order.items ?? [];
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const discount = Math.min(Math.max(0, order.discountAmount ?? 0), subtotal);

  let discountLeft = discount;
  const lines: OrderVatLine[] = items.map((item, idx) => {
    const isLast = idx === items.length - 1;
    const share = isLast ? discountLeft : subtotal > 0 ? Math.round((discount * item.subtotal) / subtotal) : 0;
    const lineDiscount = Math.min(share, item.subtotal, discountLeft);
    discountLeft -= lineDiscount;
    const variant = [item.color, item.size].filter(Boolean).join(', ');
    const total = item.quantity * item.unitPrice - lineDiscount;
    return {
      name: variant ? `${item.productName} (${variant})` : item.productName,
      unit: 'Cái',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: lineDiscount,
      total,
      vatAmount: Math.round((total * vatRate) / 100),
    };
  });

  const shippingFee = Math.max(0, order.shippingFee ?? 0);
  if (shippingFee > 0) {
    lines.push({
      name: 'Phí vận chuyển',
      unit: 'Lần',
      quantity: 1,
      unitPrice: shippingFee,
      discountAmount: 0,
      total: shippingFee,
      vatAmount: Math.round((shippingFee * vatRate) / 100),
    });
  }

  return {
    lines,
    totalBeforeTax: lines.reduce((s, l) => s + l.total, 0),
    vatAmount: lines.reduce((s, l) => s + l.vatAmount, 0),
  };
}
