import { formatVnd } from '../zalo-bot/order-message.formatter';
import { fitParamToSpec, formatVnDate, parseMappingJson, ZbsTemplateParamSpec } from './zbs-template.mapper';

/**
 * PROMOTION template mapping (admin campaigns). Parameter NAMES come from the approved Zalo
 * template (ZALO_ZBS_PROMOTION_PARAMS), e.g. template 652780:
 *   {"customer_name":"customerName","coupon_code":"couponCode","coupon_value":"couponValue",
 *    "min_order_value":"minOrderValue","start_date":"startDate","end_date":"endDate"}
 * Every value is derived from the stored Promotion/coupon and the recipient's account — the
 * admin never types message text, so a campaign can't promise what the coupon doesn't give.
 */

export const ZBS_PROMOTION_SOURCES = [
  'customerName',
  'couponCode',
  'couponValue',
  'couponValueWithCap',
  'maxDiscount',
  'minOrderValue',
  'startDate',
  'endDate',
  'promotionName',
] as const;
export type ZbsPromotionSource = (typeof ZBS_PROMOTION_SOURCES)[number];

const TRUNCATABLE: ReadonlySet<ZbsPromotionSource> = new Set(['customerName', 'promotionName']);

/** Used when the recipient's account has no name — never blocks a send. */
export const ZBS_PROMOTION_NAME_FALLBACK = 'Quý khách';

export interface ZbsPromotionParamMapping {
  param: string;
  source?: ZbsPromotionSource;
  constValue?: string;
}

export function parsePromotionParamMapping(raw: string): { mapping: ZbsPromotionParamMapping[]; errors: string[] } {
  return parseMappingJson<ZbsPromotionSource>(raw, ZBS_PROMOTION_SOURCES, 'ZALO_ZBS_PROMOTION_PARAMS');
}

/** The subset of Promotion + CouponItem + recipient the mapper reads. */
export interface ZbsPromotionInput {
  customerName?: string;
  promotion: { name: string; startDate: Date | string; endDate: Date | string };
  coupon: { code: string; type: string; value: number; minOrderValue?: number; maxDiscountAmount?: number };
}

export type ZbsPromotionMapResult =
  | { ok: true; templateData: Record<string, string> }
  | { ok: false; errorCode: string; errorMessage: string };

export function mapPromotionToTemplateData(
  input: ZbsPromotionInput,
  mapping: ZbsPromotionParamMapping[],
  specs: ZbsTemplateParamSpec[] = [],
): ZbsPromotionMapResult {
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const templateData: Record<string, string> = {};
  for (const m of mapping) {
    let value: string;
    if (m.constValue !== undefined) {
      value = m.constValue;
    } else {
      const resolved = resolvePromotionSource(input, m.source!);
      if (!resolved.ok) return { ok: false, errorCode: resolved.errorCode, errorMessage: `Tham số "${m.param}": ${resolved.message}` };
      value = resolved.value;
    }
    const fitted = fitParamToSpec(m.param, value, !!m.source && TRUNCATABLE.has(m.source), specByName.get(m.param));
    if (!fitted.ok) return fitted;
    templateData[m.param] = fitted.value;
  }
  return { ok: true, templateData };
}

/** "20%" / "50.000đ" — what the coupon takes off. */
export function describeCouponValue(coupon: ZbsPromotionInput['coupon']): string {
  return coupon.type === 'percentage' ? `${Number(coupon.value)}%` : formatVnd(coupon.value);
}

type Resolved = { ok: true; value: string } | { ok: false; errorCode: string; message: string };

function resolvePromotionSource(input: ZbsPromotionInput, source: ZbsPromotionSource): Resolved {
  const { coupon, promotion } = input;
  const cap = Number(coupon.maxDiscountAmount) || 0;
  switch (source) {
    case 'customerName': {
      const name = String(input.customerName ?? '').replace(/\s+/g, ' ').trim();
      return { ok: true, value: name || ZBS_PROMOTION_NAME_FALLBACK };
    }
    case 'couponCode':
      return coupon.code ? { ok: true, value: coupon.code } : { ok: false, errorCode: 'COUPON_FIELD_MISSING', message: 'mã coupon trống' };
    case 'couponValue':
      return { ok: true, value: describeCouponValue(coupon) };
    case 'couponValueWithCap':
      return {
        ok: true,
        value: coupon.type === 'percentage' && cap > 0 ? `${describeCouponValue(coupon)} (tối đa ${formatVnd(cap)})` : describeCouponValue(coupon),
      };
    case 'maxDiscount':
      return { ok: true, value: cap > 0 ? formatVnd(cap) : 'Không giới hạn' };
    case 'minOrderValue':
      return { ok: true, value: formatVnd(Number(coupon.minOrderValue) || 0) };
    case 'startDate':
    case 'endDate': {
      const d = new Date(source === 'startDate' ? promotion.startDate : promotion.endDate);
      if (isNaN(d.getTime())) return { ok: false, errorCode: 'PROMOTION_FIELD_MISSING', message: 'chương trình không có ngày hợp lệ' };
      return { ok: true, value: formatVnDate(d, false) };
    }
    case 'promotionName':
      return { ok: true, value: String(promotion.name ?? '').trim() || 'Luxe Glow' };
  }
}
