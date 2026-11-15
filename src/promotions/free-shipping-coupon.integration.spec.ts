import { BadRequestException } from '@nestjs/common';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  DEFAULT_FREE_SHIP_CODE,
  DEFAULT_FREE_SHIP_SYSTEM_KEY,
  DiscountType,
  Promotion,
  PromotionDocument,
  PromotionSchema,
} from './schemas/promotion.schema';
import { PromotionsService } from './promotions.service';
import { Order, OrderDocument, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto } from '../orders/dto/order.dto';

/**
 * Free-shipping coupons over a real (in-memory) MongoDB: the boot seed of FREE_SHIP, pricing against
 * the shipping fee, customer-facing rejection reasons, and the order total charged at checkout.
 */
jest.setTimeout(60_000);

const userId = new Types.ObjectId().toString();
const HCM = 'Thành phố Hồ Chí Minh';
const HANOI = 'Thành phố Hà Nội';

let mongod: MongoMemoryServer;
let conn: Connection;
let PromotionModel: Model<PromotionDocument>;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let promotions: PromotionsService;

async function program(coupons: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return PromotionModel.create({
    name: 'CT test',
    startDate: new Date(Date.now() - 86400_000),
    endDate: new Date(Date.now() + 86400_000),
    isActive: true,
    assignedToAll: true,
    coupons: coupons.map((c) => ({
      value: 0, minOrderValue: 0, maxDiscountAmount: 0, totalUsageLimit: 0, perUserUsageLimit: 1, ...c,
    })),
    ...extra,
  });
}

function buildOrders() {
  const products = {
    findById: jest.fn(async () => ({
      name: 'Đèn ngủ in 3D', slug: 'den', stock: 10, finalPrice: 259000, images: ['img'], colors: [], sizes: [],
    })),
  };
  const notifications = {
    orderCreatedOutboxFields: () => ({}),
    einvoiceRequestedOutboxEvents: () => [],
    kick: jest.fn(),
  };
  return new OrdersService(
    OrderModel,
    VersionModel,
    products as never,
    { clearCart: jest.fn() } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    promotions,
    { findById: jest.fn(async () => ({ name: 'Khách' })) } as never,
    {} as never,
    notifications as never,
  );
}

function orderDto(city: string, couponCodes: string[]): CreateOrderDto {
  return {
    items: [{ productId: new Types.ObjectId().toString(), quantity: 1 }],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city },
    couponCodes,
    acceptTerms: true,
  } as CreateOrderDto;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  PromotionModel = conn.model(Promotion.name, PromotionSchema) as unknown as Model<PromotionDocument>;
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  await Promise.all([PromotionModel.init(), OrderModel.init(), VersionModel.init()]);
  promotions = new PromotionsService(PromotionModel);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([PromotionModel.deleteMany({}), OrderModel.deleteMany({}), VersionModel.deleteMany({})]);
});

describe('default FREE_SHIP seed', () => {
  it('creates one inactive program for everyone, once, even with concurrent boots', async () => {
    const results = await Promise.all([
      promotions.ensureDefaultFreeShipCoupon(),
      promotions.ensureDefaultFreeShipCoupon(),
      promotions.ensureDefaultFreeShipCoupon(),
    ]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);

    const all = await PromotionModel.find().lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ systemKey: DEFAULT_FREE_SHIP_SYSTEM_KEY, isActive: false, assignedToAll: true });
    expect(all[0].coupons).toHaveLength(1);
    expect(all[0].coupons[0]).toMatchObject({
      code: DEFAULT_FREE_SHIP_CODE, type: DiscountType.FREE_SHIPPING, maxDiscountAmount: 0, perUserUsageLimit: 1,
    });
  });

  it('is skipped when FREE_SHIP already exists elsewhere, and survives the shop editing it', async () => {
    await program([{ code: 'FREE_SHIP', type: DiscountType.FREE_SHIPPING }]);
    expect(await promotions.ensureDefaultFreeShipCoupon()).toBe('exists');
    expect(await PromotionModel.countDocuments()).toBe(1);

    await PromotionModel.deleteMany({});
    await promotions.ensureDefaultFreeShipCoupon();
    // Shop removes the code from the seeded program → the seed must not bring it back.
    await PromotionModel.updateOne({}, { $set: { coupons: [] } });
    expect(await promotions.ensureDefaultFreeShipCoupon()).toBe('exists');
    expect((await PromotionModel.findOne().lean())!.coupons).toHaveLength(0);
  });

  it('cannot be deleted (only switched off)', async () => {
    await promotions.ensureDefaultFreeShipCoupon();
    const seeded = await PromotionModel.findOne().lean();
    await expect(promotions.remove(seeded!._id.toString())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('works at checkout once the shop activates it', async () => {
    await promotions.ensureDefaultFreeShipCoupon();
    const before = await promotions.validateCoupons(userId, { couponCodes: ['free_ship'], orderTotal: 259000, city: HCM });
    expect(before.appliedCoupons).toHaveLength(0);
    expect(before.rejectedCoupons[0].code).toBe('FREE_SHIP');

    await PromotionModel.updateOne({}, { $set: { isActive: true } });
    const after = await promotions.validateCoupons(userId, { couponCodes: ['free_ship'], orderTotal: 259000, city: HCM });
    expect(after).toMatchObject({ shippingDiscount: 22000, shippingFee: 22000, totalDiscount: 0, finalTotal: 259000 });
    expect(after.appliedCoupons).toEqual([{ code: 'FREE_SHIP', name: 'Miễn phí vận chuyển', discountAmount: 22000, kind: 'shipping' }]);
  });
});

describe('validateCoupons with free shipping', () => {
  it('waives the whole fee for the delivery province, or up to the cap', async () => {
    await program([
      { code: 'SHIPALL', type: DiscountType.FREE_SHIPPING },
      { code: 'SHIP15', type: DiscountType.FREE_SHIPPING, maxDiscountAmount: 15000 },
    ]);
    const all = await promotions.validateCoupons(userId, { couponCodes: ['SHIPALL'], orderTotal: 200000, city: HANOI });
    expect(all.shippingDiscount).toBe(27000);
    const capped = await promotions.validateCoupons(userId, { couponCodes: ['SHIP15'], orderTotal: 200000, city: HANOI });
    expect(capped.shippingDiscount).toBe(15000);
  });

  it('stacks with a goods coupon; floor rule only looks at the goods total', async () => {
    await program([
      { code: 'GIAM10', type: DiscountType.PERCENTAGE, value: 10 },
      { code: 'SHIPALL', type: DiscountType.FREE_SHIPPING },
    ]);
    const r = await promotions.validateCoupons(userId, { couponCodes: ['GIAM10', 'SHIPALL'], orderTotal: 60000, city: HCM });
    expect(r).toMatchObject({ totalDiscount: 6000, finalTotal: 54000, shippingDiscount: 22000, rejectedCoupons: [] });
    expect(r.appliedCoupons.map((a) => a.kind)).toEqual(['order', 'shipping']);
  });

  it('explains every code it does not apply', async () => {
    await program([
      { code: 'SHIP1', type: DiscountType.FREE_SHIPPING },
      { code: 'SHIP2', type: DiscountType.FREE_SHIPPING },
      { code: 'MIN500', type: DiscountType.FREE_SHIPPING, minOrderValue: 500000 },
      { code: 'HETLUOT', type: DiscountType.FIXED, value: 10000, totalUsageLimit: 1, totalUsedCount: 1 },
      { code: 'GIAMSAU', type: DiscountType.FIXED, value: 200000 },
    ]);
    const noCity = await promotions.validateCoupons(userId, { couponCodes: ['SHIP1'], orderTotal: 200000 });
    expect(noCity.appliedCoupons).toHaveLength(0);
    expect(noCity.shippingFee).toBeNull();
    expect(noCity.rejectedCoupons[0].reason).toMatch(/địa chỉ giao hàng/);

    const r = await promotions.validateCoupons(userId, {
      couponCodes: ['SHIP1', 'ship2', 'MIN500', 'HETLUOT', 'GIAMSAU', 'KHONGCO'],
      orderTotal: 200000,
      city: HCM,
    });
    expect(r.appliedCoupons.map((a) => a.code)).toEqual(['SHIP1']);
    const reasons = Object.fromEntries(r.rejectedCoupons.map((x) => [x.code, x.reason]));
    expect(reasons.SHIP2).toMatch(/1 mã miễn phí vận chuyển/);
    expect(reasons.MIN500).toMatch(/tối thiểu/);
    expect(reasons.HETLUOT).toMatch(/hết lượt/);
    expect(reasons.GIAMSAU).toMatch(/50/);
    expect(reasons.KHONGCO).toMatch(/không tồn tại/);
  });

  it('honours the per-user limit after the code was used', async () => {
    await program([{ code: 'SHIPALL', type: DiscountType.FREE_SHIPPING }]);
    await promotions.markUsed(userId, ['SHIPALL']);
    const r = await promotions.validateCoupons(userId, { couponCodes: ['SHIPALL'], orderTotal: 200000, city: HCM });
    expect(r.rejectedCoupons[0].reason).toMatch(/hết lượt của mã/);
  });
});

describe('admin coupon settings', () => {
  it('free_shipping ignores value; switching type keeps the right fields', async () => {
    const p = await program([]);
    const saved = await promotions.addCoupon(p._id.toString(), {
      code: 'freeship30', type: DiscountType.FREE_SHIPPING, value: 99, maxDiscountAmount: 30000,
    });
    const c = saved.coupons[0];
    expect(c).toMatchObject({ code: 'FREESHIP30', type: 'free_shipping', value: 0, maxDiscountAmount: 30000 });

    const fixed = await promotions.updateCoupon(p._id.toString(), c._id.toString(), { type: DiscountType.FIXED, value: 20000 });
    expect(fixed.coupons[0]).toMatchObject({ type: 'fixed', value: 20000, maxDiscountAmount: 0 });

    await expect(
      promotions.updateCoupon(p._id.toString(), c._id.toString(), { type: DiscountType.PERCENTAGE, value: 150 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('checkout with a free-shipping code', () => {
  it('charges the shipping fee net of the code and records it on the order', async () => {
    await program([
      { code: 'GIAM20K', type: DiscountType.FIXED, value: 20000 },
      { code: 'SHIPALL', type: DiscountType.FREE_SHIPPING },
    ]);
    const order = await buildOrders().create(userId, orderDto(HANOI, ['GIAM20K', 'SHIPALL']));
    expect(order).toMatchObject({
      subtotal: 259000,
      discountAmount: 20000,
      shippingFee: 0,
      shippingDiscount: 27000,
      total: 239000,
    });
    expect(order.appliedCoupons.map((a) => [a.code, a.kind, a.discountAmount])).toEqual([
      ['GIAM20K', 'order', 20000],
      ['SHIPALL', 'shipping', 27000],
    ]);

    const promo = await PromotionModel.findOne().lean();
    expect(promo!.coupons.find((c) => c.code === 'SHIPALL')!.totalUsedCount).toBe(1);
  });

  it('prices the code against the server fee, not the client', async () => {
    await program([{ code: 'SHIP25', type: DiscountType.FREE_SHIPPING, maxDiscountAmount: 25000 }]);
    const order = await buildOrders().create(userId, orderDto(HCM, ['SHIP25']));
    expect(order).toMatchObject({ shippingFee: 0, shippingDiscount: 22000, total: 259000 });
  });
});
