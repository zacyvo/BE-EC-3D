import {
  buildTrackingId,
  compareMappingWithTemplate,
  formatVnDate,
  mapOrderToTemplateData,
  parseParamMapping,
  ZbsOrderInput,
} from './zbs-template.mapper';

const ORDER_ID = '66f1a2b3c4d5e6f708192a3b';
const order = (over: Partial<ZbsOrderInput> = {}): ZbsOrderInput => ({
  _id: ORDER_ID,
  createdAt: new Date('2026-10-18T02:30:00.000Z'), // 09:30 VN
  status: 'PENDING',
  items: [{ quantity: 2 }, { quantity: 1 }],
  shippingInfo: { recipientName: '  Nguyễn   Văn A ' },
  total: 259000,
  paidAmount: 0,
  ...over,
});

const MAPPING_JSON = JSON.stringify({
  customer_name: 'customerName',
  order_code: 'orderCode',
  order_total: 'orderTotal',
  order_status: 'orderStatus',
});

describe('parseParamMapping', () => {
  it('parses approved param names → order sources, and const: values', () => {
    const { mapping, errors } = parseParamMapping(JSON.stringify({ customer_name: 'customerName', shop: 'const:Luxe Glow' }));
    expect(errors).toEqual([]);
    expect(mapping).toEqual([
      { param: 'customer_name', source: 'customerName' },
      { param: 'shop', constValue: 'Luxe Glow' },
    ]);
  });

  it.each([
    ['', /chưa được cấu hình/],
    ['not json', /không phải JSON/],
    ['[1,2]', /JSON object/],
    ['{"a b":"orderCode"}', /không hợp lệ/],
    ['{"x":"shippingAddress"}', /không được hỗ trợ/],
    ['{"x":123}', /phải là chuỗi/],
    ['{}', /không có tham số/],
  ])('rejects %p', (raw, msg) => {
    const { errors } = parseParamMapping(raw);
    expect(errors.join(' ')).toMatch(msg);
  });
});

describe('mapOrderToTemplateData (TEST 09)', () => {
  const { mapping } = parseParamMapping(MAPPING_JSON);

  it('maps real order fields to the configured approved params only', () => {
    const r = mapOrderToTemplateData(order(), mapping);
    expect(r).toEqual({
      ok: true,
      templateData: {
        customer_name: 'Nguyễn Văn A',
        order_code: '#08192A3B',
        order_total: '259.000đ',
        order_status: 'Đã tiếp nhận',
      },
    });
  });

  it('TEST 22: new COD order (PENDING) says "Đã tiếp nhận" — never confirmed/paid', () => {
    const r = mapOrderToTemplateData(order(), mapping);
    expect(r.ok && r.templateData.order_status).toBe('Đã tiếp nhận');
    expect(JSON.stringify(r)).not.toMatch(/thanh toán|xác nhận/i);
  });

  it('TEST 23: payment pending → paymentStatus says unpaid; only a full paidAmount says paid', () => {
    const m = parseParamMapping('{"pay":"paymentStatus","method":"paymentMethod"}').mapping;
    const unpaid = mapOrderToTemplateData(order(), m);
    expect(unpaid.ok && unpaid.templateData.pay).toBe('Chưa thanh toán');
    expect(unpaid.ok && unpaid.templateData.method).toBe('Thanh toán khi nhận hàng (COD)');
    const partial = mapOrderToTemplateData(order({ paidAmount: 100000 }), m);
    expect(partial.ok && partial.templateData.pay).not.toMatch(/^Đã thanh toán đủ/);
    const full = mapOrderToTemplateData(order({ paidAmount: 259000 }), m);
    expect(full.ok && full.templateData.pay).toBe('Đã thanh toán đủ');
  });

  it('later statuses use the real status; unsupported (CANCELLED) is refused', () => {
    expect(mapOrderToTemplateData(order({ status: 'CONFIRMED' }), mapping)).toMatchObject({
      ok: true,
      templateData: { order_status: 'Đã xác nhận' },
    });
    expect(mapOrderToTemplateData(order({ status: 'CANCELLED' }), mapping)).toMatchObject({
      ok: false,
      errorCode: 'ORDER_STATUS_UNSUPPORTED',
    });
  });

  it('other sources: number total, dates in VN time, item count, order URL', () => {
    const m = parseParamMapping(
      '{"t":"orderTotalNumber","d":"orderDate","dt":"orderDateTime","n":"itemCount","u":"orderUrl","id":"orderId"}',
    ).mapping;
    const r = mapOrderToTemplateData(order(), m, { orderUrlBase: 'https://luxe-glow.vn/' });
    expect(r).toEqual({
      ok: true,
      templateData: {
        t: '259000',
        d: '18/10/2026',
        dt: '09:30 18/10/2026',
        n: '3',
        u: `https://luxe-glow.vn/orders/${ORDER_ID}`,
        id: ORDER_ID,
      },
    });
  });

  it('orderUrl without a configured storefront base → validation error (no guessed URL)', () => {
    const m = parseParamMapping('{"u":"orderUrl"}').mapping;
    expect(mapOrderToTemplateData(order(), m)).toMatchObject({ ok: false, errorCode: 'ORDER_URL_NOT_CONFIGURED' });
  });

  it('enforces approved maxLength: names are shortened, codes/amounts never are', () => {
    const specs = [
      { name: 'customer_name', maxLength: 6 },
      { name: 'order_code', maxLength: 30 },
      { name: 'order_total', maxLength: 30 },
      { name: 'order_status', maxLength: 30 },
    ];
    const r = mapOrderToTemplateData(order(), mapping, { specs });
    expect(r.ok && r.templateData.customer_name).toBe('Nguyễ…');
    const tight = mapOrderToTemplateData(order(), mapping, { specs: [{ name: 'order_code', maxLength: 4 }] });
    expect(tight).toMatchObject({ ok: false, errorCode: 'TEMPLATE_PARAM_TOO_LONG' });
  });

  it('missing customer name → validation error, never an invented value', () => {
    expect(mapOrderToTemplateData(order({ shippingInfo: {} }), mapping)).toMatchObject({ ok: false, errorCode: 'ORDER_FIELD_MISSING' });
  });
});

describe('compareMappingWithTemplate (TEST 15 support)', () => {
  it('flags missing required and unknown params', () => {
    const { mapping } = parseParamMapping(MAPPING_JSON);
    const res = compareMappingWithTemplate(mapping, [
      { name: 'customer_name', require: true },
      { name: 'order_code', require: true },
      { name: 'order_total', require: true },
      { name: 'payment_link', require: true },
    ]);
    expect(res).toEqual({ compatible: false, missingRequired: ['payment_link'], unknownParams: ['order_status'] });
  });
});

describe('tracking id', () => {
  it('is stable, alphanumeric and ≤ 48 chars', () => {
    const t = buildTrackingId(ORDER_ID);
    expect(t).toBe(`LGOC${ORDER_ID}`);
    expect(t).toMatch(/^[A-Za-z0-9]{1,48}$/);
    expect(buildTrackingId(ORDER_ID)).toBe(t);
  });
});

describe('formatVnDate', () => {
  it('crosses midnight correctly (UTC 17:30 → next day in VN)', () => {
    expect(formatVnDate(new Date('2026-10-18T17:30:00Z'), true)).toBe('00:30 19/10/2026');
  });
});
