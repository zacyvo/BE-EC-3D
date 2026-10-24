import { ZALO_MESSAGE_MAX_LENGTH } from './zalo-bot.constants';

/** Subset of the saved Order this formatter reads — a plain `order.toObject()` fits. Every
 * field is optional on purpose: missing data renders as "(không có)", never throws. */
export interface OrderMessageInput {
  _id?: { toString(): string } | string;
  createdAt?: Date | string;
  status?: string;
  items?: Array<{
    productName?: string;
    quantity?: number;
    subtotal?: number;
    color?: string;
    size?: string;
  }>;
  shippingInfo?: { recipientName?: string; phone?: string };
  subtotal?: number;
  discountAmount?: number;
  shippingFee?: number;
  total?: number;
  paidAmount?: number;
  /** Not on the Order schema today (storefront checkout is COD-only — see
   * frontend-user/src/app/checkout/page.tsx). Read if a future payment flow adds it. */
  paymentMethod?: string;
  customerNote?: string;
  cancelRequest?: { requestedAt?: Date | string; reason?: string; requestedByName?: string };
  cancelReason?: string;
  customerCancel?: { cancelledAt?: Date | string; cancelledByName?: string };
}

export interface OrderMessageOptions {
  /** Admin dashboard origin, e.g. https://admin.luxe-glow.vn — no trailing slash. */
  adminUrl?: string;
  /** Show the full phone number instead of the masked one. Off by default (PII). */
  showFullPhone?: boolean;
  maxLength?: number;
}

/** Same labels as the admin dashboard (frontend-admin/src/lib/utils.ts ORDER_STATUS_MAP). */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chờ xác nhận',
  CONFIRMED: 'Đã xác nhận',
  PROCESSING: 'Đang xử lý',
  SHIPPED: 'Đang giao',
  DELIVERED: 'Đã giao',
  CANCELLED: 'Đã hủy',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  COD: 'COD (thanh toán khi nhận hàng)',
  BANK_TRANSFER: 'Chuyển khoản',
};

/** The only payment method the storefront offers today. */
const DEFAULT_PAYMENT_METHOD = 'COD';

const MISSING = '(không có)';
const MAX_ITEM_NAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 200;

/** 259000 → "259.000đ" (vi-VN grouping). */
export function formatVnd(amount: number | undefined | null): string {
  const n = Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : 0;
  return `${new Intl.NumberFormat('vi-VN').format(n)}đ`;
}

/** "0912345689" → "09******89". Keeps only the first/last 2 digits. */
export function maskPhone(phone: string | undefined | null): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return MISSING;
  if (digits.length < 6) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/** Display code used across the admin UI: last 8 chars of the ObjectId, uppercased. */
export function orderDisplayCode(orderId: string): string {
  return `#${orderId.slice(-8).toUpperCase()}`;
}

export function buildAdminOrderUrl(adminUrl: string | undefined, orderId: string): string | null {
  if (!adminUrl || !orderId) return null;
  return `${adminUrl.replace(/\/+$/, '')}/orders?search=${encodeURIComponent(orderId)}`;
}

/** Never says "paid" unless paidAmount actually covers the total. */
export function describePaymentStatus(total: number, paidAmount: number): string {
  const t = Math.max(0, Number(total) || 0);
  const p = Math.max(0, Number(paidAmount) || 0);
  if (t > 0 && p >= t) return 'Đã thanh toán đủ';
  if (p > 0) return `Đã thanh toán ${formatVnd(p)} — còn lại ${formatVnd(t - p)}`;
  return 'Chưa thanh toán';
}

function formatDateTime(value: Date | string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  }).format(d);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function itemLine(item: NonNullable<OrderMessageInput['items']>[number]): string {
  const name = truncate(item.productName || 'Sản phẩm', MAX_ITEM_NAME_LENGTH);
  const variant = [item.color, item.size].filter(Boolean).join(', ');
  const qty = Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1;
  const amount = item.subtotal !== undefined ? ` — ${formatVnd(item.subtotal)}` : '';
  return `- ${name}${variant ? ` (${truncate(variant, 40)})` : ''} x ${qty}${amount}`;
}

/**
 * Builds the plain-text ORDER_CREATED message from the saved order. Fits in Zalo's
 * 2000-character limit: items are added until the budget runs out, then a
 * "… và N sản phẩm khác" line points the owner to the admin link for the rest.
 */
export function formatOrderCreatedMessage(order: OrderMessageInput, options: OrderMessageOptions = {}): string {
  const maxLength = options.maxLength ?? ZALO_MESSAGE_MAX_LENGTH;
  const orderId = order._id ? order._id.toString() : '';
  const items = order.items ?? [];
  const total = Number(order.total) || 0;
  const paymentMethod = order.paymentMethod || DEFAULT_PAYMENT_METHOD;
  const adminLink = buildAdminOrderUrl(options.adminUrl, orderId);

  const header: string[] = ['🔔 LUXE GLOW — ĐƠN HÀNG MỚI', ''];
  header.push(`Mã đơn: ${orderId ? orderDisplayCode(orderId) : MISSING}`);
  const createdAt = formatDateTime(order.createdAt);
  if (createdAt) header.push(`Thời gian: ${createdAt}`);
  header.push('');
  header.push(`Khách hàng: ${order.shippingInfo?.recipientName ? truncate(order.shippingInfo.recipientName, 80) : MISSING}`);
  header.push(
    `SĐT: ${options.showFullPhone ? order.shippingInfo?.phone || MISSING : maskPhone(order.shippingInfo?.phone)}`,
  );
  header.push('');
  header.push(`Sản phẩm (${items.length}):`);

  const footer: string[] = [''];
  if (order.subtotal !== undefined && order.subtotal !== total) footer.push(`Tạm tính: ${formatVnd(order.subtotal)}`);
  if (Number(order.discountAmount) > 0) footer.push(`Giảm giá: -${formatVnd(order.discountAmount)}`);
  if (Number(order.shippingFee) > 0) footer.push(`Phí vận chuyển: ${formatVnd(order.shippingFee)}`);
  footer.push(`Tổng tiền: ${formatVnd(total)}`);
  footer.push(`Thanh toán: ${PAYMENT_METHOD_LABELS[paymentMethod] ?? paymentMethod}`);
  footer.push(`Trạng thái thanh toán: ${describePaymentStatus(total, Number(order.paidAmount) || 0)}`);
  footer.push(`Trạng thái đơn: ${order.status ? ORDER_STATUS_LABELS[order.status] ?? order.status : MISSING}`);
  if (order.customerNote?.trim()) footer.push(`Ghi chú: ${truncate(order.customerNote, MAX_NOTE_LENGTH)}`);
  if (adminLink) footer.push('', 'Xem đơn hàng:', adminLink);

  const fixedLength = [...header, ...footer].join('\n').length;
  const itemLines: string[] = [];
  let used = fixedLength;
  for (let i = 0; i < items.length; i++) {
    const line = itemLine(items[i]);
    const remaining = items.length - i - 1;
    // Reserve room for the "… và N sản phẩm khác" line in case later items don't fit.
    const reserve = remaining > 0 ? `\n… và ${remaining} sản phẩm khác`.length : 0;
    if (used + 1 + line.length + reserve > maxLength) {
      itemLines.push(`… và ${items.length - i} sản phẩm khác`);
      break;
    }
    itemLines.push(line);
    used += 1 + line.length;
  }
  if (!items.length) itemLines.push(MISSING);

  const message = [...header, ...itemLines, ...footer].join('\n');
  // Last-resort guard (e.g. an absurd maxLength): never hand Zalo an oversized text.
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

/**
 * Plain-text ORDER_CANCEL_REQUESTED message: "<khách> yêu cầu hủy đơn hàng <mã>" + the admin
 * link, so the owner can act on it. Short by construction (all free text is truncated).
 */
export function formatOrderCancelRequestedMessage(order: OrderMessageInput, options: OrderMessageOptions = {}): string {
  const maxLength = options.maxLength ?? ZALO_MESSAGE_MAX_LENGTH;
  const orderId = order._id ? order._id.toString() : '';
  const code = orderId ? orderDisplayCode(orderId) : MISSING;
  const request = order.cancelRequest ?? {};
  const name = request.requestedByName?.trim() || order.shippingInfo?.recipientName?.trim() || 'Khách hàng';
  const adminLink = buildAdminOrderUrl(options.adminUrl, orderId);

  const lines: string[] = ['⚠️ LUXE GLOW — YÊU CẦU HỦY ĐƠN', ''];
  lines.push(`${truncate(name, 80)} yêu cầu hủy đơn hàng ${code}`);
  const requestedAt = formatDateTime(request.requestedAt);
  if (requestedAt) lines.push(`Thời gian yêu cầu: ${requestedAt}`);
  lines.push(`Trạng thái đơn: ${order.status ? ORDER_STATUS_LABELS[order.status] ?? order.status : MISSING}`);
  lines.push(`Tổng tiền: ${formatVnd(order.total)}`);
  if (request.reason?.trim()) lines.push(`Lý do: ${truncate(request.reason, MAX_NOTE_LENGTH)}`);
  if (adminLink) lines.push('', 'Xem đơn hàng:', adminLink);

  const message = lines.join('\n');
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

/**
 * Plain-text ORDER_CANCELLED_BY_CUSTOMER message: "<khách> đã hủy đơn hàng <mã>" + the admin
 * link. Informational — the order was still awaiting confirmation, so nothing is left to do.
 */
export function formatOrderCancelledByCustomerMessage(order: OrderMessageInput, options: OrderMessageOptions = {}): string {
  const maxLength = options.maxLength ?? ZALO_MESSAGE_MAX_LENGTH;
  const orderId = order._id ? order._id.toString() : '';
  const code = orderId ? orderDisplayCode(orderId) : MISSING;
  const cancel = order.customerCancel ?? {};
  const name = cancel.cancelledByName?.trim() || order.shippingInfo?.recipientName?.trim() || 'Khách hàng';
  const adminLink = buildAdminOrderUrl(options.adminUrl, orderId);

  const lines: string[] = ['❌ LUXE GLOW — KHÁCH ĐÃ HỦY ĐƠN', ''];
  lines.push(`${truncate(name, 80)} đã hủy đơn hàng ${code}`);
  const cancelledAt = formatDateTime(cancel.cancelledAt);
  if (cancelledAt) lines.push(`Thời gian hủy: ${cancelledAt}`);
  lines.push('Đơn đang chờ xác nhận nên đã được hủy ngay — shop không cần xử lý thêm.');
  lines.push(`Tổng tiền: ${formatVnd(order.total)}`);
  if (order.cancelReason?.trim()) lines.push(`Lý do: ${truncate(order.cancelReason, MAX_NOTE_LENGTH)}`);
  if (adminLink) lines.push('', 'Xem đơn hàng:', adminLink);

  const message = lines.join('\n');
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}
