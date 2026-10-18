import { describePaymentStatus, formatVnd, orderDisplayCode } from '../zalo-bot/order-message.formatter';
import { ZBS_TRACKING_ID_MAX_LENGTH } from './zalo-zbs.constants';

/**
 * ORDER_CONFIRMATION template mapping. Parameter NAMES come from the approved Zalo template
 * (configured in ZALO_ZBS_ORDER_CONFIRMATION_PARAMS) — nothing here assumes them. This file
 * only defines which order facts may be sent and how each one is rendered.
 */

/** Order facts a template parameter may be mapped to. */
export const ZBS_ORDER_SOURCES = [
  'customerName',
  'orderCode',
  'orderId',
  'orderTotal',
  'orderTotalNumber',
  'orderStatus',
  'orderDate',
  'orderDateTime',
  'itemCount',
  'paymentMethod',
  'paymentStatus',
  'orderUrl',
] as const;
export type ZbsOrderSource = (typeof ZBS_ORDER_SOURCES)[number];

/** Only free text may be shortened to fit a param's maxLength; codes/amounts never are. */
const TRUNCATABLE: ReadonlySet<ZbsOrderSource> = new Set(['customerName']);

export interface ZbsParamMapping {
  /** Template parameter name exactly as approved by Zalo. */
  param: string;
  /** Order fact, or undefined for a fixed text (`const:` mapping). */
  source?: ZbsOrderSource;
  constValue?: string;
}

/** Constraints of one approved param, from GET /template/info/v2 `listParams`. */
export interface ZbsTemplateParamSpec {
  name: string;
  require?: boolean;
  type?: string;
  maxLength?: number;
  minLength?: number;
  acceptNull?: boolean;
}

const PARAM_NAME = /^[A-Za-z0-9_]{1,64}$/;
const MAX_CONST_LENGTH = 200;

/**
 * Parses ZALO_ZBS_ORDER_CONFIRMATION_PARAMS, e.g.
 *   {"customer_name":"customerName","order_code":"orderCode","order_total":"orderTotal",
 *    "order_status":"orderStatus","shop":"const:Luxe Glow"}
 */
export function parseParamMapping(raw: string): { mapping: ZbsParamMapping[]; errors: string[] } {
  const errors: string[] = [];
  if (!raw.trim()) return { mapping: [], errors: ['ZALO_ZBS_ORDER_CONFIRMATION_PARAMS chưa được cấu hình'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mapping: [], errors: ['ZALO_ZBS_ORDER_CONFIRMATION_PARAMS không phải JSON hợp lệ'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { mapping: [], errors: ['ZALO_ZBS_ORDER_CONFIRMATION_PARAMS phải là JSON object {"tham_so":"nguồn"}'] };
  }
  const mapping: ZbsParamMapping[] = [];
  for (const [param, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PARAM_NAME.test(param)) {
      errors.push(`Tên tham số "${param}" không hợp lệ (chỉ chữ, số, gạch dưới; tối đa 64 ký tự)`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`Tham số "${param}": giá trị phải là chuỗi`);
      continue;
    }
    if (value.startsWith('const:')) {
      const text = value.slice('const:'.length);
      if (!text.trim() || text.length > MAX_CONST_LENGTH) {
        errors.push(`Tham số "${param}": const phải dài 1–${MAX_CONST_LENGTH} ký tự`);
        continue;
      }
      mapping.push({ param, constValue: text });
    } else if ((ZBS_ORDER_SOURCES as readonly string[]).includes(value)) {
      mapping.push({ param, source: value as ZbsOrderSource });
    } else {
      errors.push(`Tham số "${param}": nguồn "${value}" không được hỗ trợ (hợp lệ: ${ZBS_ORDER_SOURCES.join(', ')}, const:<text>)`);
    }
  }
  if (!mapping.length && !errors.length) errors.push('ZALO_ZBS_ORDER_CONFIRMATION_PARAMS không có tham số nào');
  return { mapping, errors };
}

/** Mapping ↔ approved template params: every required param must be mapped, and nothing
 * outside the approved list may be sent. */
export function compareMappingWithTemplate(
  mapping: ZbsParamMapping[],
  specs: ZbsTemplateParamSpec[],
): { compatible: boolean; missingRequired: string[]; unknownParams: string[] } {
  const mapped = new Set(mapping.map((m) => m.param));
  const known = new Set(specs.map((s) => s.name));
  const missingRequired = specs.filter((s) => s.require !== false && !mapped.has(s.name)).map((s) => s.name);
  const unknownParams = [...mapped].filter((p) => !known.has(p));
  return { compatible: !missingRequired.length && !unknownParams.length, missingRequired, unknownParams };
}

/** Subset of the saved Order the mapper reads. */
export interface ZbsOrderInput {
  _id: { toString(): string } | string;
  createdAt?: Date | string;
  status?: string;
  items?: Array<{ quantity?: number }>;
  shippingInfo?: { recipientName?: string };
  total?: number;
  paidAmount?: number;
}

/**
 * What the customer is told about their order. Wording is deliberately factual: a new
 * PENDING order is "Đã tiếp nhận" (received) — never "đã xác nhận" or "đã thanh toán".
 * CANCELLED never reaches the mapper (the worker skips cancelled orders).
 */
export const ZBS_ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Đã tiếp nhận',
  CONFIRMED: 'Đã xác nhận',
  PROCESSING: 'Đang xử lý',
  SHIPPED: 'Đang giao',
  DELIVERED: 'Đã giao',
};

/** The storefront checkout is COD-only (frontend-user/src/app/checkout/page.tsx) and Order
 * has no paymentMethod field — same assumption as the owner Bot message. */
const PAYMENT_METHOD_LABEL = 'Thanh toán khi nhận hàng (COD)';

export interface ZbsMapContext {
  /** Storefront origin for `orderUrl`, e.g. https://luxe-glow.vn (never the admin domain). */
  orderUrlBase?: string;
  /** listParams from the verified template, when known — enforces min/max length. */
  specs?: ZbsTemplateParamSpec[];
}

export type ZbsMapResult =
  | { ok: true; templateData: Record<string, string> }
  | { ok: false; errorCode: string; errorMessage: string };

export function mapOrderToTemplateData(
  order: ZbsOrderInput,
  mapping: ZbsParamMapping[],
  ctx: ZbsMapContext = {},
): ZbsMapResult {
  const specByName = new Map((ctx.specs ?? []).map((s) => [s.name, s]));
  const templateData: Record<string, string> = {};

  for (const m of mapping) {
    let value: string | null;
    if (m.constValue !== undefined) {
      value = m.constValue;
    } else {
      const resolved = resolveSource(order, m.source!, ctx);
      if (!resolved.ok) return { ok: false, errorCode: resolved.errorCode, errorMessage: `Tham số "${m.param}": ${resolved.message}` };
      value = resolved.value;
    }

    const spec = specByName.get(m.param);
    if (spec?.maxLength && spec.maxLength > 0 && value.length > spec.maxLength) {
      if (m.source && TRUNCATABLE.has(m.source) && spec.maxLength >= 2) {
        value = `${value.slice(0, spec.maxLength - 1).trimEnd()}…`;
      } else {
        return {
          ok: false,
          errorCode: 'TEMPLATE_PARAM_TOO_LONG',
          errorMessage: `Tham số "${m.param}" dài ${value.length} ký tự, template chỉ cho phép ${spec.maxLength}`,
        };
      }
    }
    if (!value && spec?.acceptNull === false) {
      return { ok: false, errorCode: 'TEMPLATE_PARAM_EMPTY', errorMessage: `Tham số "${m.param}" không được để trống` };
    }
    if (spec?.minLength && value.length < spec.minLength) {
      return {
        ok: false,
        errorCode: 'TEMPLATE_PARAM_TOO_SHORT',
        errorMessage: `Tham số "${m.param}" cần tối thiểu ${spec.minLength} ký tự`,
      };
    }
    templateData[m.param] = value;
  }
  return { ok: true, templateData };
}

type Resolved = { ok: true; value: string } | { ok: false; errorCode: string; message: string };

function resolveSource(order: ZbsOrderInput, source: ZbsOrderSource, ctx: ZbsMapContext): Resolved {
  const orderId = order._id.toString();
  const total = Number(order.total);
  switch (source) {
    case 'customerName': {
      const name = String(order.shippingInfo?.recipientName ?? '').replace(/\s+/g, ' ').trim();
      return name ? { ok: true, value: name } : { ok: false, errorCode: 'ORDER_FIELD_MISSING', message: 'đơn không có tên người nhận' };
    }
    case 'orderCode':
      return { ok: true, value: orderDisplayCode(orderId) };
    case 'orderId':
      return { ok: true, value: orderId };
    case 'orderTotal':
    case 'orderTotalNumber':
      if (!Number.isFinite(total) || total < 0) {
        return { ok: false, errorCode: 'ORDER_FIELD_MISSING', message: 'tổng tiền không hợp lệ' };
      }
      return { ok: true, value: source === 'orderTotal' ? formatVnd(total) : String(Math.round(total)) };
    case 'orderStatus': {
      const label = ZBS_ORDER_STATUS_LABELS[String(order.status)];
      return label ? { ok: true, value: label } : { ok: false, errorCode: 'ORDER_STATUS_UNSUPPORTED', message: `trạng thái ${order.status} không gửi xác nhận` };
    }
    case 'orderDate':
    case 'orderDateTime': {
      const d = order.createdAt ? new Date(order.createdAt) : null;
      if (!d || isNaN(d.getTime())) return { ok: false, errorCode: 'ORDER_FIELD_MISSING', message: 'đơn không có ngày tạo' };
      return { ok: true, value: formatVnDate(d, source === 'orderDateTime') };
    }
    case 'itemCount': {
      const n = (order.items ?? []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      return { ok: true, value: String(n) };
    }
    case 'paymentMethod':
      return { ok: true, value: PAYMENT_METHOD_LABEL };
    case 'paymentStatus':
      return { ok: true, value: describePaymentStatus(total, Number(order.paidAmount) || 0) };
    case 'orderUrl': {
      if (!ctx.orderUrlBase) {
        return { ok: false, errorCode: 'ORDER_URL_NOT_CONFIGURED', message: 'chưa cấu hình ZALO_ZBS_ORDER_URL_BASE / FRONTEND_URL' };
      }
      return { ok: true, value: `${ctx.orderUrlBase.replace(/\/+$/, '')}/orders/${encodeURIComponent(orderId)}` };
    }
  }
}

/** dd/MM/yyyy [HH:mm] in Asia/Ho_Chi_Minh (UTC+7, no DST) — independent of server TZ. */
export function formatVnDate(d: Date, withTime: boolean): string {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()}`;
  return withTime ? `${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())} ${date}` : date;
}

/** Stable per (template, order): "LGOC" + 24-hex ObjectId = 28 alphanumeric chars. Reused on
 * manual retries so every attempt for the same notification reconciles to one id. */
export function buildTrackingId(orderId: string): string {
  return `LGOC${orderId}`.replace(/[^A-Za-z0-9]/g, '').slice(0, ZBS_TRACKING_ID_MAX_LENGTH);
}
