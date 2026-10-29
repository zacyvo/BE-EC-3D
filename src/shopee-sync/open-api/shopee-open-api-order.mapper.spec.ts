import { OrderStatus } from '../../orders/schemas/order.schema';
import {
  computeOrderMoney,
  mapShopeeApiOrderStatus,
  resolveOrderStatusFromRow,
  SHOPEE_API_ROW_KEYS,
  SHOPEE_ORDER_COLUMNS,
  buildShippingPreviewFromGroup,
} from '../shopee-order-mapping.util';
import { mapShopeeApiOrderToRows, ShopeeOrderMappingError } from './shopee-open-api-order.mapper';
import { resolveRange } from './shopee-open-api-order-sync.service';
import type { ShopeeOrderDetail } from './shopee-open-api.types';

const order: ShopeeOrderDetail = {
  order_sn: '2610290ABCDEF',
  order_status: 'COMPLETED',
  create_time: 1761700000,
  total_amount: 162000,
  message_to_seller: 'Giao giờ hành chính',
  buyer_username: 'buyer_abc',
  shipping_carrier: 'SPX Express',
  recipient_address: {
    name: 'N****n',
    phone: '******17',
    town: 'Phường Phú Thọ Hòa',
    state: 'TP. Hồ Chí Minh',
    full_address: '315/3 Vườn Lài, Phường Phú Thọ Hòa, TP. Hồ Chí Minh',
  },
  package_list: [{ package_number: 'OFG123' }],
  item_list: [
    { item_id: 25988349424, item_name: 'Đèn Loopy Lamp', model_name: 'Cam', model_quantity_purchased: 1, model_original_price: 160000, model_discounted_price: 145000 },
    { item_id: 26841255552, item_name: 'Móc khoá', model_name: '', model_quantity_purchased: 2, model_original_price: 0, model_discounted_price: 0 },
  ],
};

describe('mapShopeeApiOrderToRows', () => {
  it('one row per line, order-level fields repeated, API keys attached', () => {
    const rows = mapShopeeApiOrderToRows(order, {
      escrow: { order_income: { escrow_amount: 104217, buyer_paid_shipping_fee: 17000 } },
      trackingNumber: 'SPXVN0123',
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r[SHOPEE_ORDER_COLUMNS.orderCode]).toBe('2610290ABCDEF');
      expect(r[SHOPEE_ORDER_COLUMNS.trackingCode]).toBe('SPXVN0123');
      expect(r[SHOPEE_ORDER_COLUMNS.packageCode]).toBe('OFG123');
      expect(r[SHOPEE_API_ROW_KEYS.orderStatus]).toBe('COMPLETED');
    }
    expect(rows[0][SHOPEE_API_ROW_KEYS.itemId]).toBe('25988349424');
    expect(rows[0][SHOPEE_ORDER_COLUMNS.offerPrice]).toBe('145000');
    expect(rows[1][SHOPEE_ORDER_COLUMNS.quantity]).toBe('2');
    expect(rows[0][SHOPEE_ORDER_COLUMNS.status]).toBe('Hoàn thành');
    expect(new Date(rows[0][SHOPEE_ORDER_COLUMNS.orderDate]).getTime()).toBe(1761700000 * 1000);

    const ship = buildShippingPreviewFromGroup(rows);
    expect(ship).toMatchObject({ city: 'TP. Hồ Chí Minh', ward: 'Phường Phú Thọ Hòa', note: 'Giao giờ hành chính', phone: '******17' });
  });

  it('money: total/subtotal invariant holds and sellerRevenue = Shopee escrow_amount', () => {
    const rows = mapShopeeApiOrderToRows({ ...order, item_list: [order.item_list![0]] }, {
      escrow: { order_income: { escrow_amount: 104217, buyer_paid_shipping_fee: 17000 } },
    });
    const m = computeOrderMoney(rows);
    expect(m).toMatchObject({ subtotal: 145000, shippingFee: 17000, total: 162000, discountAmount: 0, sellerRevenue: 104217 });
    expect(m.total).toBe(m.subtotal - m.discountAmount + m.shippingFee);
  });

  it('without escrow (not completed yet) shipping is inferred and the Excel fee formula is the fallback', () => {
    const rows = mapShopeeApiOrderToRows({ ...order, order_status: 'SHIPPED', item_list: [order.item_list![0]] });
    const m = computeOrderMoney(rows);
    expect(m.shippingFee).toBe(17000);
    expect(rows[0][SHOPEE_API_ROW_KEYS.escrowAmount]).toBe('');
    expect(resolveOrderStatusFromRow(rows[0])).toBe(OrderStatus.SHIPPED);
  });

  it('rejects orders it cannot represent', () => {
    expect(() => mapShopeeApiOrderToRows({ ...order, item_list: [] })).toThrow(ShopeeOrderMappingError);
    expect(() => mapShopeeApiOrderToRows({ ...order, order_sn: '' })).toThrow(ShopeeOrderMappingError);
  });
});

describe('mapShopeeApiOrderStatus', () => {
  it.each([
    ['UNPAID', OrderStatus.PENDING],
    ['READY_TO_SHIP', OrderStatus.PROCESSING],
    ['PROCESSED', OrderStatus.PROCESSING],
    ['IN_CANCEL', OrderStatus.PROCESSING],
    ['SHIPPED', OrderStatus.SHIPPED],
    ['TO_CONFIRM_RECEIVE', OrderStatus.SHIPPED],
    ['COMPLETED', OrderStatus.DELIVERED],
    ['CANCELLED', OrderStatus.CANCELLED],
    ['TO_RETURN', OrderStatus.CANCELLED],
    ['SOMETHING_NEW', OrderStatus.PROCESSING],
  ])('%s → %s', (api, expected) => expect(mapShopeeApiOrderStatus(api)).toBe(expected));

  it('Excel rows (no API key) still use the Vietnamese keyword classifier', () => {
    expect(resolveOrderStatusFromRow({ [SHOPEE_ORDER_COLUMNS.status]: 'Hoàn thành' })).toBe(OrderStatus.DELIVERED);
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  it('defaults to the last 7 days', () => {
    const r = resolveRange({}, now);
    expect(r.to).toEqual(now);
    expect(now.getTime() - r.from.getTime()).toBe(7 * 86_400_000);
  });
  it('caps `to` at now and rejects bad ranges', () => {
    expect(resolveRange({ from: '2026-10-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }, now).to).toEqual(now);
    expect(() => resolveRange({ from: '2026-10-29T11:00:00Z' }, now)).toThrow();
    expect(() => resolveRange({ from: '2026-01-01T00:00:00Z' }, now)).toThrow(/90/);
  });
});
