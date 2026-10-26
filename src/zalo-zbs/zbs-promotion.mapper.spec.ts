import { mapPromotionToTemplateData, parsePromotionParamMapping, ZbsPromotionInput } from './zbs-promotion.mapper';

/** Params of the approved "Chương trình khuyến mãi" template 652780. */
const MAPPING_JSON = JSON.stringify({
  customer_name: 'customerName',
  coupon_code: 'couponCode',
  coupon_value: 'couponValue',
  min_order_value: 'minOrderValue',
  start_date: 'startDate',
  end_date: 'endDate',
});

const input = (over: Partial<ZbsPromotionInput> = {}): ZbsPromotionInput => ({
  customerName: 'Nguyễn Văn A',
  // 2026-10-18 00:00 and 2026-11-17 23:59 Vietnam time.
  promotion: { name: 'ZALO_OA', startDate: new Date('2026-10-17T17:00:00Z'), endDate: new Date('2026-11-17T16:59:59Z') },
  coupon: { code: 'ZALO_OA', type: 'percentage', value: 20, minOrderValue: 50000, maxDiscountAmount: 1000000 },
  ...over,
});

describe('parsePromotionParamMapping', () => {
  it('accepts the 652780 mapping', () => {
    const { mapping, errors } = parsePromotionParamMapping(MAPPING_JSON);
    expect(errors).toEqual([]);
    expect(mapping.map((m) => m.param)).toEqual(['customer_name', 'coupon_code', 'coupon_value', 'min_order_value', 'start_date', 'end_date']);
  });

  it('rejects order sources and names the promotion env var', () => {
    const { errors } = parsePromotionParamMapping('{"x":"orderTotal"}');
    expect(errors[0]).toContain('nguồn "orderTotal" không được hỗ trợ');
    expect(parsePromotionParamMapping('').errors).toEqual(['ZALO_ZBS_PROMOTION_PARAMS chưa được cấu hình']);
    expect(parsePromotionParamMapping('{bad').errors).toEqual(['ZALO_ZBS_PROMOTION_PARAMS không phải JSON hợp lệ']);
  });
});

describe('mapPromotionToTemplateData', () => {
  const { mapping } = parsePromotionParamMapping(MAPPING_JSON);

  it('renders the 652780 params from the coupon (VN dates, VND amounts)', () => {
    const res = mapPromotionToTemplateData(input(), mapping);
    expect(res).toEqual({
      ok: true,
      templateData: {
        customer_name: 'Nguyễn Văn A',
        coupon_code: 'ZALO_OA',
        coupon_value: '20%',
        min_order_value: '50.000đ',
        start_date: '18/10/2026',
        end_date: '17/11/2026',
      },
    });
  });

  it('fixed coupons are shown in VND; zero minimum is 0đ', () => {
    const res = mapPromotionToTemplateData(input({ coupon: { code: 'GIAM50K', type: 'fixed', value: 50000, minOrderValue: 0 } }), mapping);
    expect(res.ok && res.templateData.coupon_value).toBe('50.000đ');
    expect(res.ok && res.templateData.min_order_value).toBe('0đ');
  });

  it('couponValueWithCap / maxDiscount describe the cap', () => {
    const m = parsePromotionParamMapping('{"v":"couponValueWithCap","cap":"maxDiscount"}').mapping;
    const capped = mapPromotionToTemplateData(input(), m);
    expect(capped.ok && capped.templateData).toEqual({ v: '20% (tối đa 1.000.000đ)', cap: '1.000.000đ' });
    const uncapped = mapPromotionToTemplateData(input({ coupon: { code: 'X', type: 'percentage', value: 10, maxDiscountAmount: 0 } }), m);
    expect(uncapped.ok && uncapped.templateData).toEqual({ v: '10%', cap: 'Không giới hạn' });
  });

  it('a missing name falls back to "Quý khách" instead of blocking the send', () => {
    const res = mapPromotionToTemplateData(input({ customerName: '   ' }), mapping);
    expect(res.ok && res.templateData.customer_name).toBe('Quý khách');
  });

  it('truncates the name to maxLength but never the coupon code', () => {
    const specs = [
      { name: 'customer_name', maxLength: 10 },
      { name: 'coupon_code', maxLength: 5 },
    ];
    const name = mapPromotionToTemplateData(input({ customerName: 'Nguyễn Thị Hồng Nhung' }), mapping.slice(0, 1), specs);
    expect(name.ok && name.templateData.customer_name).toBe('Nguyễn Th…');
    const code = mapPromotionToTemplateData(input(), mapping, specs);
    expect(code).toMatchObject({ ok: false, errorCode: 'TEMPLATE_PARAM_TOO_LONG' });
  });

  it('const values are sent verbatim', () => {
    const m = parsePromotionParamMapping('{"shop":"const:Luxe Glow"}').mapping;
    expect(mapPromotionToTemplateData(input(), m)).toEqual({ ok: true, templateData: { shop: 'Luxe Glow' } });
  });
});
