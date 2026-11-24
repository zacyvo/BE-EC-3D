import { BadRequestException } from '@nestjs/common';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DiscountType, Promotion, PromotionDocument, PromotionRegion, PromotionSchema } from './schemas/promotion.schema';
import { PromotionsService } from './promotions.service';
import { checkTimeConditions, describeConditions, compactConditions } from './promotion-conditions.util';
import { Order, OrderDocument, OrderSchema, OrderStatus, ReturnStatus } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto } from '../orders/dto/order.dto';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { Product, ProductDocument, ProductSchema } from '../products/schemas/product.schema';
import { Category, CategoryDocument, CategorySchema } from '../categories/schemas/category.schema';

/**
 * Program conditions ("Điều kiện áp dụng") over a real (in-memory) MongoDB: customer history
 * (new account, first order, completed orders, total spent, birthday, win-back, opt-in), order rules
 * (category scope, item count, region, payment method), time windows, exclusive programs and
 * goods codes bundling free shipping — through validate and through placing the order.
 */
jest.setTimeout(60_000);

const DAY = 86_400_000;
const HCM = 'Thành phố Hồ Chí Minh';
const HANOI = 'Thành phố Hà Nội';

let mongod: MongoMemoryServer;
let conn: Connection;
let PromotionModel: Model<PromotionDocument>;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let UserModel: Model<UserDocument>;
let ProductModel: Model<ProductDocument>;
let CategoryModel: Model<CategoryDocument>;
let promotions: PromotionsService;

let catLamp: Types.ObjectId;
let catKey: Types.ObjectId;
let lamp: Types.ObjectId;
let keychain: Types.ObjectId;

async function makeUser(extra: Record<string, unknown> = {}): Promise<string> {
  const _id = new Types.ObjectId();
  // Raw insert: lets the test backdate createdAt (timestamps would overwrite it).
  await UserModel.collection.insertOne({
    _id, email: `${_id}@test.vn`, name: 'Khách', isDeleted: false, marketingOptIn: false,
    createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  return _id.toString();
}

async function pastOrder(userId: string, status: OrderStatus, total: number, extra: Record<string, unknown> = {}) {
  await OrderModel.collection.insertOne({
    userId: new Types.ObjectId(userId), status, total, subtotal: total, isDeleted: false, items: [],
    createdAt: new Date(Date.now() - 10 * DAY), ...extra,
  });
}

async function program(
  conditions: Record<string, unknown>,
  coupons: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  return PromotionModel.create({
    name: 'CT test',
    startDate: new Date(Date.now() - DAY),
    endDate: new Date(Date.now() + DAY),
    isActive: true,
    assignedToAll: true,
    conditions,
    coupons: coupons.map((c) => ({
      type: DiscountType.PERCENTAGE, value: 10, minOrderValue: 0, maxDiscountAmount: 0,
      totalUsageLimit: 0, perUserUsageLimit: 5, ...c,
    })),
    ...extra,
  });
}

const validate = (userId: string, codes: string[], extra: Record<string, unknown> = {}) =>
  promotions.validateCoupons(userId, { couponCodes: codes, orderTotal: 500_000, ...extra } as never);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  PromotionModel = conn.model(Promotion.name, PromotionSchema) as unknown as Model<PromotionDocument>;
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  UserModel = conn.model(User.name, UserSchema) as unknown as Model<UserDocument>;
  ProductModel = conn.model(Product.name, ProductSchema) as unknown as Model<ProductDocument>;
  CategoryModel = conn.model(Category.name, CategorySchema) as unknown as Model<CategoryDocument>;
  promotions = new PromotionsService(PromotionModel, OrderModel, UserModel, ProductModel, CategoryModel);

  catLamp = new Types.ObjectId();
  catKey = new Types.ObjectId();
  lamp = new Types.ObjectId();
  keychain = new Types.ObjectId();
  await CategoryModel.collection.insertMany([
    { _id: catLamp, name: 'Đèn ngủ', slug: 'den-ngu', isDeleted: false },
    { _id: catKey, name: 'Móc khoá', slug: 'moc-khoa', isDeleted: false },
  ]);
  await ProductModel.collection.insertMany([
    { _id: lamp, name: 'Đèn', slug: 'den', category: catLamp, isDeleted: false },
    { _id: keychain, name: 'Móc', slug: 'moc', category: catKey, isDeleted: false },
  ]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([
    PromotionModel.deleteMany({}), OrderModel.deleteMany({}), VersionModel.deleteMany({}), UserModel.deleteMany({}),
  ]);
});

describe('customer conditions', () => {
  it('new account: only accounts registered within N days', async () => {
    await program({ newAccountWithinDays: 30 }, [{ code: 'WELCOME' }]);
    const fresh = await makeUser({ createdAt: new Date(Date.now() - 5 * DAY) });
    const old = await makeUser({ createdAt: new Date(Date.now() - 40 * DAY) });

    expect((await validate(fresh, ['WELCOME'])).totalDiscount).toBe(50_000);
    expect((await validate(old, ['WELCOME'])).rejectedCoupons[0].reason).toMatch(/tài khoản mới.*30 ngày/);
  });

  it('first order: any non-cancelled order disqualifies, a cancelled one does not', async () => {
    await program({ firstOrderOnly: true }, [{ code: 'FIRST' }]);
    const u = await makeUser();
    await pastOrder(u, OrderStatus.CANCELLED, 300_000);
    expect((await validate(u, ['FIRST'])).appliedCoupons).toHaveLength(1);

    await pastOrder(u, OrderStatus.PENDING, 300_000);
    expect((await validate(u, ['FIRST'])).rejectedCoupons[0].reason).toMatch(/đơn hàng đầu tiên/);
  });

  it('total spent counts DELIVERED orders only, minus refunds of settled returns', async () => {
    await program({ minTotalSpent: 1_000_000 }, [{ code: 'VIP' }]);
    const u = await makeUser();
    await pastOrder(u, OrderStatus.DELIVERED, 800_000);
    await pastOrder(u, OrderStatus.DELIVERED, 400_000, {
      returnRequest: { status: ReturnStatus.COMPLETED, refundAmount: 300_000 },
    });
    await pastOrder(u, OrderStatus.SHIPPED, 5_000_000); // not completed yet

    const res = await validate(u, ['VIP']);
    expect(res.rejectedCoupons[0].reason).toMatch(/tổng chi tiêu từ 1\.000\.000₫ \(bạn đang có 900\.000₫\)/);

    await pastOrder(u, OrderStatus.DELIVERED, 100_000);
    expect((await validate(u, ['VIP'])).appliedCoupons).toHaveLength(1);
  });

  it('completed orders range (min / max)', async () => {
    await program({ minCompletedOrders: 2, maxCompletedOrders: 3 }, [{ code: 'LOYAL' }]);
    const u = await makeUser();
    await pastOrder(u, OrderStatus.DELIVERED, 100_000);
    expect((await validate(u, ['LOYAL'])).rejectedCoupons[0].reason).toMatch(/từ 2 đơn hàng thành công \(bạn đang có 1\)/);
    await pastOrder(u, OrderStatus.DELIVERED, 100_000);
    expect((await validate(u, ['LOYAL'])).appliedCoupons).toHaveLength(1);
    await pastOrder(u, OrderStatus.DELIVERED, 100_000);
    await pastOrder(u, OrderStatus.DELIVERED, 100_000);
    expect((await validate(u, ['LOYAL'])).rejectedCoupons[0].reason).toMatch(/tối đa 3/);
  });

  it('birthday month, win-back and marketing opt-in', async () => {
    await program({ birthdayMonthOnly: true }, [{ code: 'BDAY' }]);
    await program({ inactiveDays: 30 }, [{ code: 'COMEBACK' }]);
    await program({ marketingOptInOnly: true }, [{ code: 'NEWS' }]);

    const noDob = await makeUser();
    expect((await validate(noDob, ['BDAY'])).rejectedCoupons[0].reason).toMatch(/cập nhật ngày sinh/);
    const bday = await makeUser({ dob: new Date(Date.UTC(1995, new Date(Date.now() + 7 * 3600_000).getUTCMonth(), 15)) });
    expect((await validate(bday, ['BDAY'])).appliedCoupons).toHaveLength(1);

    // never bought → not a returning customer; bought 10 days ago → too recent; 40 days ago → ok
    expect((await validate(noDob, ['COMEBACK'])).rejectedCoupons[0].reason).toMatch(/từng mua hàng/);
    await pastOrder(noDob, OrderStatus.DELIVERED, 200_000);
    expect((await validate(noDob, ['COMEBACK'])).rejectedCoupons[0].reason).toMatch(/sau 30 ngày/);
    const lapsed = await makeUser();
    await pastOrder(lapsed, OrderStatus.DELIVERED, 200_000, { createdAt: new Date(Date.now() - 40 * DAY) });
    expect((await validate(lapsed, ['COMEBACK'])).appliedCoupons).toHaveLength(1);

    expect((await validate(noDob, ['NEWS'])).rejectedCoupons[0].reason).toMatch(/nhận tin/);
    const optedIn = await makeUser({ marketingOptIn: true });
    expect((await validate(optedIn, ['NEWS'])).appliedCoupons).toHaveLength(1);
  });

  it('my-coupons hides programs the customer does not qualify for and describes the rest', async () => {
    await program({ firstOrderOnly: true }, [{ code: 'FIRST' }]);
    await program({ minTotalSpent: 5_000_000 }, [{ code: 'VIP' }]);
    await program({ categoryIds: [catLamp], weekdays: [5, 6] }, [{ code: 'LAMP' }], { exclusive: true });
    const u = await makeUser();

    const mine = await promotions.getMyCoupons(u);
    expect(mine.map((c) => c.code).sort()).toEqual(['FIRST', 'LAMP']);
    expect(mine.find((c) => c.code === 'LAMP')!.conditionTexts).toEqual([
      'Áp dụng cho: Đèn ngủ', 'Thứ 6, Thứ 7', 'Không dùng chung mã khác',
    ]);
  });
});

describe('order conditions', () => {
  const items = [
    { productId: '', quantity: 1, subtotal: 300_000 },
    { productId: '', quantity: 2, subtotal: 200_000 },
  ];
  const cart = () => [
    { ...items[0], productId: lamp.toString() },
    { ...items[1], productId: keychain.toString() },
  ];

  it('category scope discounts only the eligible lines; no eligible line → rejected', async () => {
    await program({ categoryIds: [catLamp] }, [{ code: 'LAMP20', value: 20 }]);
    await program({ productIds: [keychain] }, [{ code: 'KEY50K', type: DiscountType.FIXED, value: 500_000 }]);
    const u = await makeUser();

    expect((await validate(u, ['LAMP20'], { items: cart() })).totalDiscount).toBe(60_000); // 20% of 300k
    // fixed amount is capped by the eligible lines (200k), not the whole order
    expect((await validate(u, ['KEY50K'], { items: cart(), orderTotal: 1_000_000 })).totalDiscount).toBe(200_000);
    const none = await validate(u, ['LAMP20'], { items: [cart()[1]], orderTotal: 200_000 });
    expect(none.rejectedCoupons[0].reason).toMatch(/chưa có sản phẩm thuộc chương trình/);
  });

  it('min item quantity, region and payment method', async () => {
    await program({ minItemQuantity: 4 }, [{ code: 'BUY4' }]);
    await program({ region: PromotionRegion.OUTSIDE_HCM }, [{ code: 'TINH' }]);
    await program({ paymentMethods: ['BANK_TRANSFER'] }, [{ code: 'CK' }]);
    const u = await makeUser();

    expect((await validate(u, ['BUY4'], { items: cart() })).rejectedCoupons[0].reason).toMatch(/tối thiểu 4 sản phẩm.*\(đang có 3\)/);
    expect((await validate(u, ['BUY4'], { items: [...cart(), { ...cart()[1], quantity: 1 }] })).appliedCoupons).toHaveLength(1);

    expect((await validate(u, ['TINH'])).rejectedCoupons[0].reason).toMatch(/Chọn địa chỉ/);
    expect((await validate(u, ['TINH'], { city: HCM })).rejectedCoupons[0].reason).toMatch(/ngoài TP\. Hồ Chí Minh/);
    expect((await validate(u, ['TINH'], { city: HANOI })).appliedCoupons).toHaveLength(1);

    expect((await validate(u, ['CK'], { paymentMethod: 'COD' })).rejectedCoupons[0].reason).toMatch(/chuyển khoản/);
    expect((await validate(u, ['CK'], { paymentMethod: 'BANK_TRANSFER' })).appliedCoupons).toHaveLength(1);
  });

  it('exclusive program codes are never combined', async () => {
    await program({}, [{ code: 'SOLO' }], { exclusive: true });
    await program({}, [{ code: 'OTHER', type: DiscountType.FIXED, value: 10_000 }]);
    const u = await makeUser();

    const a = await validate(u, ['OTHER', 'SOLO']);
    expect(a.appliedCoupons.map((c) => c.code)).toEqual(['OTHER']);
    expect(a.rejectedCoupons[0]).toMatchObject({ code: 'SOLO', reason: expect.stringMatching(/không dùng chung/) });

    const b = await validate(u, ['SOLO', 'OTHER']);
    expect(b.appliedCoupons.map((c) => c.code)).toEqual(['SOLO']);
    expect(b.rejectedCoupons[0]).toMatchObject({ code: 'OTHER', reason: 'Mã SOLO không dùng chung với mã khác' });
  });
});

describe('goods code bundling free shipping', () => {
  it('gives the goods discount and waives shipping; it is the one shipping code of the order', async () => {
    await program({}, [{ code: 'WELCOME', value: 10, maxDiscountAmount: 30_000, includeFreeShipping: true }]);
    await program({}, [{ code: 'FREE_SHIP', type: DiscountType.FREE_SHIPPING, value: 0 }]);
    const u = await makeUser();

    const res = await validate(u, ['WELCOME', 'FREE_SHIP'], { city: HANOI });
    expect(res.totalDiscount).toBe(30_000);
    expect(res.shippingDiscount).toBe(27_000);
    expect(res.appliedCoupons).toEqual([
      expect.objectContaining({ code: 'WELCOME', kind: 'order', discountAmount: 30_000 }),
      expect.objectContaining({ code: 'WELCOME', kind: 'shipping', discountAmount: 27_000 }),
    ]);
    expect(res.rejectedCoupons[0]).toMatchObject({ code: 'FREE_SHIP', reason: expect.stringMatching(/1 mã miễn phí vận chuyển/) });

    // no address yet: the goods part still applies
    const noCity = await validate(u, ['WELCOME']);
    expect(noCity).toMatchObject({ totalDiscount: 30_000, shippingDiscount: 0 });
  });

  it('places the order with both discounts and counts the code once', async () => {
    await program({ categoryIds: [catLamp], firstOrderOnly: true }, [
      { code: 'WELCOME', value: 10, includeFreeShipping: true, freeShippingMaxAmount: 15_000, perUserUsageLimit: 1 },
    ]);
    const u = await makeUser();
    const orders = buildOrders();

    const order = await orders.create(u, orderDto(HCM, ['WELCOME']));
    // lamp 259.000 ×2 — 10% = 51.800; shipping 22.000 − 15.000 cap
    expect(order).toMatchObject({ subtotal: 518_000, discountAmount: 51_800, shippingDiscount: 15_000, shippingFee: 7_000 });
    expect(order.total).toBe(518_000 - 51_800 + 7_000);

    const promo = await PromotionModel.findOne({ 'coupons.code': 'WELCOME' }).lean();
    expect(promo!.coupons[0].totalUsedCount).toBe(1);
    expect(promo!.coupons[0].usageRecords[0].count).toBe(1);

    // second order: no longer the first one (and the per-user limit is used up)
    const again = await validate(u, ['WELCOME'], { items: [{ productId: lamp.toString(), quantity: 1, subtotal: 259_000 }] });
    expect(again.appliedCoupons).toHaveLength(0);
  });
});

describe('admin rules', () => {
  it('stores only the rules that are on and rejects contradictory ones', async () => {
    const staff = new Types.ObjectId().toString();
    const base = { name: 'CT', startDate: '2026-01-01', endDate: '2099-01-01' };
    const p = await promotions.create(
      {
        ...base,
        conditions: { firstOrderOnly: true, minTotalSpent: 0, weekdays: [0, 1, 2, 3, 4, 5, 6], hourFrom: 0, hourTo: 2, productIds: [] },
      } as never,
      staff,
    );
    expect(p.toObject().conditions).toEqual({ firstOrderOnly: true, hourFrom: 0, hourTo: 2 });

    await expect(
      promotions.create({ ...base, conditions: { firstOrderOnly: true, minTotalSpent: 1_000_000 } } as never, staff),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      promotions.create({ ...base, conditions: { minCompletedOrders: 5, maxCompletedOrders: 2 } } as never, staff),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(promotions.create({ ...base, conditions: { hourFrom: 20 } } as never, staff)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // update replaces the whole conditions object
    const updated = await promotions.update(p._id.toString(), { conditions: { region: PromotionRegion.HCM } } as never);
    expect(updated.toObject().conditions).toEqual({ region: 'HCM' });
  });
});

describe('time windows (Vietnam time)', () => {
  // 2026-11-27 is a Friday. 13:30 UTC = 20:30 in Vietnam.
  const fri2030 = new Date('2026-11-27T13:30:00Z');
  it('weekdays and hour ranges, including windows that wrap midnight', () => {
    expect(checkTimeConditions({ weekdays: [5, 6] }, fri2030)).toBeNull();
    expect(checkTimeConditions({ weekdays: [6, 0] }, fri2030)).toBe('Mã chỉ áp dụng vào Thứ 7, Chủ nhật');
    expect(checkTimeConditions({ hourFrom: 20, hourTo: 22 }, fri2030)).toBeNull();
    expect(checkTimeConditions({ hourFrom: 12, hourTo: 14 }, fri2030)).toBe('Mã chỉ áp dụng trong khung giờ 12:00–14:00');
    expect(checkTimeConditions({ hourFrom: 22, hourTo: 2 }, new Date('2026-11-27T16:30:00Z'))).toBeNull(); // 23:30
    expect(checkTimeConditions({ hourFrom: 22, hourTo: 2 }, fri2030)).not.toBeNull();
  });

  it('describes and compacts conditions', () => {
    expect(describeConditions({ minTotalSpent: 2_000_000, paymentMethods: ['BANK_TRANSFER'], hourFrom: 20, hourTo: 24 })).toEqual([
      'Tổng chi tiêu từ 2.000.000₫', 'Thanh toán chuyển khoản', 'Khung giờ 20:00–00:00',
    ]);
    expect(compactConditions({ a: 0, b: false, c: [], d: 3, hourFrom: 0 })).toEqual({ d: 3, hourFrom: 0 });
  });
});

function buildOrders() {
  const products = {
    findById: jest.fn(async (id: string) => ({
      name: 'Đèn ngủ in 3D', slug: 'den', stock: 10, finalPrice: 259000, images: ['img'], colors: [], sizes: [],
      category: id === lamp.toString() ? catLamp : catKey,
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
    items: [{ productId: lamp.toString(), quantity: 2 }],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city },
    couponCodes,
    acceptTerms: true,
  } as CreateOrderDto;
}
