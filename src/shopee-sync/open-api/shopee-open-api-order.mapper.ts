import { SHOPEE_API_ROW_KEYS, SHOPEE_ORDER_COLUMNS, ShopeeOrderRawRow } from '../shopee-order-mapping.util';
import type { ShopeeApiOrderStatus, ShopeeEscrowDetailResponse, ShopeeOrderDetail } from './shopee-open-api.types';

/** Shown in the review queue / batch details in place of the Excel "Trạng Thái Đơn Hàng"
 * text. Display only — the status itself is decided from SHOPEE_API_ROW_KEYS.orderStatus. */
export const API_ORDER_STATUS_LABELS: Record<ShopeeApiOrderStatus, string> = {
  UNPAID: 'Chờ thanh toán',
  READY_TO_SHIP: 'Chờ lấy hàng',
  PROCESSED: 'Đã xử lý — chờ bàn giao vận chuyển',
  RETRY_SHIP: 'Giao lại',
  SHIPPED: 'Đang giao',
  TO_CONFIRM_RECEIVE: 'Đã giao — chờ người mua xác nhận',
  IN_CANCEL: 'Người mua đang yêu cầu huỷ',
  CANCELLED: 'Đã huỷ',
  TO_RETURN: 'Trả hàng/Hoàn tiền',
  COMPLETED: 'Hoàn thành',
  INVOICE_PENDING: 'Chờ xuất hoá đơn',
};

/** Not a sale yet (buyer hasn't paid) — skipped; picked up once its update_time changes. */
export const SKIPPED_STATUSES: ShopeeApiOrderStatus[] = ['UNPAID'];
/** Statuses after which Shopee has a settlement to report (escrow released). */
export const ESCROW_STATUSES: ShopeeApiOrderStatus[] = ['COMPLETED'];
/** Statuses where a tracking number can exist. */
export const TRACKING_STATUSES: ShopeeApiOrderStatus[] = ['PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'TO_RETURN', 'RETRY_SHIP'];

export class ShopeeOrderMappingError extends Error {}

/**
 * One Open API order → the same `ShopeeOrderRawRow[]` (one row per line item, order-level
 * fields repeated) an Excel export produces, plus the API-only `__*` keys. This keeps a
 * single import pipeline (ShopeeOrderSyncService.importOrderGroups) for both sources.
 */
export function mapShopeeApiOrderToRows(
  order: ShopeeOrderDetail,
  extras: { escrow?: ShopeeEscrowDetailResponse | null; trackingNumber?: string | null } = {},
): ShopeeOrderRawRow[] {
  const orderSn = (order.order_sn ?? '').trim();
  if (!orderSn) throw new ShopeeOrderMappingError('Đơn thiếu order_sn');
  const items = order.item_list ?? [];
  if (items.length === 0) throw new ShopeeOrderMappingError(`Đơn ${orderSn} không có item_list`);

  const status = order.order_status ?? '';
  const subtotal = items.reduce((s, it) => s + lineUnitPrice(it) * lineQty(it), 0);
  const total = num(order.total_amount);
  const income = extras.escrow?.order_income;
  // Buyer-paid shipping is only itemized in the escrow; before settlement it's whatever
  // the buyer paid on top of the goods (vouchers already netted into total_amount).
  const buyerPaidShipping = income?.buyer_paid_shipping_fee ?? Math.max(0, total - subtotal);
  const addr = order.recipient_address ?? {};
  const pkg = order.package_list?.[0];
  const note = [order.message_to_seller, order.note].map((v) => (v ?? '').trim()).filter(Boolean).join(' — ');

  const orderLevel: ShopeeOrderRawRow = {
    [SHOPEE_ORDER_COLUMNS.orderCode]: orderSn,
    [SHOPEE_ORDER_COLUMNS.packageCode]: pkg?.package_number ?? '',
    [SHOPEE_ORDER_COLUMNS.orderDate]: order.create_time ? new Date(order.create_time * 1000).toISOString() : '',
    [SHOPEE_ORDER_COLUMNS.status]: API_ORDER_STATUS_LABELS[status as ShopeeApiOrderStatus] ?? status,
    [SHOPEE_ORDER_COLUMNS.returnStatus]: '',
    [SHOPEE_ORDER_COLUMNS.buyerComment]: '',
    [SHOPEE_ORDER_COLUMNS.trackingCode]: extras.trackingNumber ?? '',
    [SHOPEE_ORDER_COLUMNS.carrierName]: order.shipping_carrier || pkg?.shipping_carrier || '',
    [SHOPEE_ORDER_COLUMNS.estimatedDeliveryDate]: '',
    [SHOPEE_ORDER_COLUMNS.shippingFeePaidByBuyer]: String(buyerPaidShipping),
    [SHOPEE_ORDER_COLUMNS.orderTotalPaid]: String(total),
    [SHOPEE_ORDER_COLUMNS.buyerUsername]: order.buyer_username?.trim() || (order.buyer_user_id ? `shopee-${order.buyer_user_id}` : ''),
    [SHOPEE_ORDER_COLUMNS.recipientName]: orMasked(addr.name),
    [SHOPEE_ORDER_COLUMNS.phone]: orMasked(addr.phone),
    // VN addresses (post-2025 2-tier): state = tỉnh/thành, town = phường/xã. Legacy 3-tier
    // addresses may still put the district in `district`/`city` — mapped best-effort, the
    // full string is always kept in `full_address`.
    [SHOPEE_ORDER_COLUMNS.province]: orMasked(addr.state || addr.city),
    [SHOPEE_ORDER_COLUMNS.wardLegacyLabel]: orMasked(addr.town || addr.district),
    [SHOPEE_ORDER_COLUMNS.district]: (addr.town ? addr.district || (addr.state ? addr.city : '') || '' : '').trim(),
    [SHOPEE_ORDER_COLUMNS.address]: orMasked(addr.full_address),
    [SHOPEE_ORDER_COLUMNS.note]: note,
    [SHOPEE_API_ROW_KEYS.orderStatus]: status,
    [SHOPEE_API_ROW_KEYS.escrowAmount]: income?.escrow_amount !== undefined && income?.escrow_amount !== null ? String(income.escrow_amount) : '',
  };

  return items.map((it) => ({
    ...orderLevel,
    [SHOPEE_ORDER_COLUMNS.productSku]: it.item_sku ?? '',
    [SHOPEE_ORDER_COLUMNS.productName]: (it.item_name ?? '').trim(),
    [SHOPEE_ORDER_COLUMNS.variantSku]: it.model_sku ?? '',
    [SHOPEE_ORDER_COLUMNS.variantName]: (it.model_name ?? '').trim(),
    [SHOPEE_ORDER_COLUMNS.offerPrice]: String(lineUnitPrice(it)),
    [SHOPEE_ORDER_COLUMNS.quantity]: String(lineQty(it)),
    [SHOPEE_ORDER_COLUMNS.lineTotalPaid]: '',
    [SHOPEE_API_ROW_KEYS.itemId]: it.item_id ? String(it.item_id) : '',
  }));
}

/** Shopee omits recipient fields it withholds (or hasn't assigned yet). Order/issue
 * shipping fields are required, so an absent value is stored as a fully-masked one: the
 * existing masked-recipient handling then flags it to the admin, and a later sync replaces
 * it as soon as Shopee returns a real value ("only overwrite when better"). */
const MASKED_PLACEHOLDER = '***';
function orMasked(v: string | undefined | null): string {
  return (v ?? '').trim() || MASKED_PLACEHOLDER;
}

function lineUnitPrice(it: { model_discounted_price?: number; model_original_price?: number }): number {
  const discounted = num(it.model_discounted_price);
  return discounted > 0 ? discounted : num(it.model_original_price);
}

function lineQty(it: { model_quantity_purchased?: number }): number {
  return Math.max(1, Math.round(num(it.model_quantity_purchased)) || 1);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
