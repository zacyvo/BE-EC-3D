import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema, OrderStatus, PaymentMethod } from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from './schemas/order-version.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { OrdersService } from './orders.service';
import { OrderPublicAccessService } from './order-public-access.service';
import { AuditService } from '../audit/audit.service';
import { CreateOrderDto } from './dto/order.dto';
import { normalizeStreet, streetMatches } from './order-public-access.util';

/**
 * "Mua không cần đăng nhập" over a real (in-memory) MongoDB: the order goes to a "user tạm" keyed
 * on the recipient phone (never to a registered account), gets its own link + security code, can
 * be unlocked with phone + delivery street when the code is lost, found again without the link,
 * and paid by bank transfer through the link. Registering with that phone later must still work.
 */
jest.setTimeout(60_000);

const env: Record<string, string> = { JWT_SECRET: 'test-secret', FRONTEND_URL: 'https://shop.test' };

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let UserModel: Model<UserDocument>;

function build() {
  const config = { get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const users = new UsersService(UserModel, {} as never, {} as never);
  const products = {
    findById: jest.fn(async () => ({
      name: 'Đèn ngủ 3D', slug: 'den-ngu', stock: 10, images: ['img.png'], price: 259000, finalPrice: 259000, colors: [], sizes: [],
    })),
  };
  const cart = { clearCart: jest.fn() };
  const notifications = {
    orderCreatedOutboxFields: () => ({ pendingNotificationEvents: ['ORDER_CREATED'] }),
    einvoiceRequestedOutboxEvents: () => [],
    paymentReportedOutboxEvents: () => ['PAYMENT_REPORTED'],
    kick: jest.fn(),
  };
  const bankTransfer = {
    resolveAccountType: jest.fn((requested?: string) => requested),
    buildInitialPayment: jest.fn((_id: Types.ObjectId, amount: number) => ({
      method: PaymentMethod.BANK_TRANSFER, status: 'PENDING_PAYMENT', amount, reference: `LG${_id.toString().slice(-8)}`,
      verificationStatus: 'NOT_REPORTED',
      bankAccount: { bankBin: '970436', bankName: 'VCB', accountNumber: '0123456789', accountName: 'LUXE GLOW' },
    })),
    getInstructions: jest.fn(async (o: OrderDocument) => ({ orderCode: o._id.toString(), amount: o.total })),
    reportTransfer: jest.fn(async (o: OrderDocument) => ({ order: o, reported: true })),
    toInstructions: jest.fn((o: OrderDocument) => ({ orderCode: o._id.toString(), amount: o.total })),
  };
  const promotions = { validateCoupons: jest.fn(), markUsed: jest.fn() };
  const orders = new OrdersService(
    OrderModel, VersionModel, products as never, cart as never, audit, promotions as never,
    users, {} as never, notifications as never, bankTransfer as never,
  );
  jest.spyOn(orders, 'resolveVariant').mockReturnValue({ image: 'img.png' });
  jest.spyOn(orders, 'resolveShippingInfo').mockImplementation((s) => s as never);
  const access = new OrderPublicAccessService(
    OrderModel, new JwtService({}), config, {} as never, users, audit, orders,
  );
  return { orders, access, users, cart, bankTransfer, promotions };
}

const shippingInfo = { recipientName: 'Chị Lan', phone: '+84912345678', street: '12/3 Nguyễn Huệ', ward: 'Bến Nghé', city: 'TP. Hồ Chí Minh' };

function dto(overrides: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    items: [{ productId: new Types.ObjectId().toString(), quantity: 2 }],
    shippingInfo,
    acceptTerms: true,
    ...overrides,
  } as CreateOrderDto;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  UserModel = conn.model(User.name, UserSchema) as unknown as Model<UserDocument>;
  await OrderModel.syncIndexes();
  // UserSchema declares email twice (unique prop + plain index) → syncIndexes conflicts; create
  // the two unique indexes this flow relies on directly.
  await UserModel.collection.createIndex({ email: 1 }, { unique: true });
  await UserModel.collection.createIndex({ phone: 1 }, { unique: true, sparse: true });
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([OrderModel.deleteMany({}), VersionModel.deleteMany({}), UserModel.deleteMany({})]);
});

describe('guest checkout', () => {
  it('creates a "user tạm" by recipient phone and a link + code opened with that phone', async () => {
    const { orders, access, cart } = build();
    const order = await orders.createAsGuest(dto());

    const guest = await UserModel.findById(order.userId).exec();
    expect(guest).toMatchObject({ isGuest: true, phone: '0912345678', name: 'Chị Lan', email: 'guest_0912345678@guest.luxe-glow.vn' });
    expect(order.placedAsGuest).toBe(true);
    expect(order.total).toBe(259000 * 2 + 22000); // HCM flat fee
    expect(cart.clearCart).not.toHaveBeenCalled();

    const creds = access.credentialsOfNewOrder(order)!;
    expect(creds.phone).toBe('0912345678');
    const { accessJwt } = await access.verify(order.publicAccessToken!, '0912 345 678', creds.securityCode);
    expect((await access.getOrder(order.publicAccessToken!, accessJwt)).paymentMethod).toBe(PaymentMethod.COD);
    // The session issued with the checkout response works straight away.
    const checkoutJwt = await access.issueSession(order);
    await expect(access.getOrder(order.publicAccessToken!, checkoutJwt)).resolves.toHaveProperty('status', OrderStatus.PENDING);
  });

  it('reuses the same guest for the same phone, each order with its own code', async () => {
    const { orders, access } = build();
    const a = await orders.createAsGuest(dto());
    const b = await orders.createAsGuest(dto({ shippingInfo: { ...shippingInfo, phone: '0912345678', recipientName: 'Lan' } }));
    expect(b.userId.toString()).toBe(a.userId.toString());
    expect(await UserModel.countDocuments({})).toBe(1);
    expect(access.credentialsOfNewOrder(a)!.securityCode).not.toBe(access.credentialsOfNewOrder(b)!.securityCode);
  });

  it('never attaches the order to a registered account holding that phone', async () => {
    const { orders, users } = build();
    const member = await users.create({ email: 'lan@example.com', password: 'Secret@123', name: 'Lan', phone: '0912345678' });
    const order = await orders.createAsGuest(dto());
    expect(order.userId.toString()).not.toBe(member._id.toString());
    const guest = await UserModel.findById(order.userId).exec();
    expect(guest!.isGuest).toBe(true);
    expect(guest!.phone).toBeUndefined(); // the number stays with the real account
    expect(order.publicAccessPhone).toBe('0912345678');
  });

  it('requires accepting the terms, refuses coupons and blocked guests', async () => {
    const { orders, promotions } = build();
    await expect(orders.createAsGuest(dto({ acceptTerms: undefined }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(orders.createAsGuest(dto({ couponCodes: ['FREESHIP'] }))).rejects.toBeInstanceOf(BadRequestException);
    expect(promotions.validateCoupons).not.toHaveBeenCalled();

    await orders.createAsGuest(dto());
    await UserModel.updateOne({ phone: '0912345678' }, { $set: { isBlocked: true } });
    await expect(orders.createAsGuest(dto())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('registering after a guest checkout', () => {
  it('takes the phone from the guest; guest orders stay on the guest and keep their link', async () => {
    const { orders, access, users } = build();
    const order = await orders.createAsGuest(dto());
    const creds = access.credentialsOfNewOrder(order)!;

    const member = await users.create({ email: 'lan@example.com', password: 'Secret@123', name: 'Lan', phone: '+84912345678' });
    expect(member.phone).toBe('0912345678');
    const guest = await UserModel.findById(order.userId).exec();
    expect(guest!.phone).toBeUndefined();
    expect((await OrderModel.find({ userId: member._id }).exec())).toHaveLength(0);
    await expect(access.verify(order.publicAccessToken!, '0912345678', creds.securityCode)).resolves.toHaveProperty('accessJwt');

    // Next guest checkout with that phone still uses the same guest, not the new account.
    const next = await orders.createAsGuest(dto());
    expect(next.userId.toString()).toBe(order.userId.toString());
  });

  it('refuses a phone already used by another real account (no raw duplicate-key error)', async () => {
    const { users } = build();
    const a = await users.create({ email: 'a@example.com', password: 'Secret@123', name: 'A', phone: '0912345678' });
    await expect(users.create({ email: 'b@example.com', password: 'Secret@123', name: 'B', phone: '0912345678' }))
      .rejects.toBeInstanceOf(ConflictException);
    const b = await users.create({ email: 'b@example.com', password: 'Secret@123', name: 'B' });
    await expect(users.updateProfile(b._id.toString(), { phone: '0912345678' })).rejects.toBeInstanceOf(ConflictException);
    await expect(users.updateProfile(a._id.toString(), { phone: '0912345678', name: 'A2' })).resolves.toHaveProperty('name', 'A2');
  });
});

describe('"Quên mã bảo mật" — phone + delivery street', () => {
  it('unlocks with the street typed differently (accents, case, punctuation)', async () => {
    const { orders, access } = build();
    const order = await orders.createAsGuest(dto());
    await expect(access.verify(order.publicAccessToken!, '0912345678', undefined, '12/3  nguyen hue'))
      .resolves.toHaveProperty('accessJwt');
  });

  it('wrong street counts toward the lock', async () => {
    const { orders, access } = build();
    const order = await orders.createAsGuest(dto());
    const { securityCode } = access.credentialsOfNewOrder(order)!;
    for (let i = 0; i < 5; i++) {
      await expect(access.verify(order.publicAccessToken!, '0912345678', undefined, '99 Lê Lợi'))
        .rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(access.verify(order.publicAccessToken!, '0912345678', securityCode)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the right street with another phone is refused', async () => {
    const { orders, access } = build();
    const order = await orders.createAsGuest(dto());
    await expect(access.verify(order.publicAccessToken!, '0987654321', undefined, shippingInfo.street))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('"Tra cứu đơn hàng" without the link', () => {
  it('phone + code finds that one order; phone + street finds every order delivered there', async () => {
    const { orders, access } = build();
    const a = await orders.createAsGuest(dto());
    const b = await orders.createAsGuest(dto());
    await orders.createAsGuest(dto({ shippingInfo: { ...shippingInfo, street: '5 Lê Lợi' } }));
    await orders.createAsGuest(dto({ shippingInfo: { ...shippingInfo, phone: '0987654321' } }));

    const byCode = await access.lookup('0912345678', access.credentialsOfNewOrder(a)!.securityCode);
    expect(byCode.orders.map((o) => o.token)).toEqual([a.publicAccessToken]);
    await expect(access.getOrder(a.publicAccessToken!, byCode.orders[0].accessJwt)).resolves.toHaveProperty('total');

    const byStreet = await access.lookup('0912345678', undefined, '12/3 Nguyen Hue');
    expect(byStreet.orders.map((o) => o.token).sort()).toEqual([a.publicAccessToken, b.publicAccessToken].sort());
    expect(byStreet.orders[0]).toMatchObject({ itemCount: 2, firstItemName: 'Đèn ngủ 3D' });
  });

  it('unknown phone and wrong credentials look the same; misses lock the phone\'s orders', async () => {
    const { orders, access } = build();
    const a = await orders.createAsGuest(dto());
    const { securityCode } = access.credentialsOfNewOrder(a)!;

    await expect(access.lookup('0933333333', 'ABCDEFGH')).rejects.toThrow('Số điện thoại, mã bảo mật hoặc địa chỉ không đúng');
    await expect(access.lookup('not-a-phone', 'ABCDEFGH')).rejects.toBeInstanceOf(UnauthorizedException);
    for (let i = 0; i < 5; i++) {
      await expect(access.lookup('0912345678', 'ABCDEFGH')).rejects.toThrow('Số điện thoại, mã bảo mật hoặc địa chỉ không đúng');
    }
    await expect(access.lookup('0912345678', securityCode)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('bank transfer through the link', () => {
  it('shows the VietQR instructions and records "Tôi đã chuyển khoản" for the session\'s order only', async () => {
    const { orders, access, bankTransfer } = build();
    const order = await orders.createAsGuest(dto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const other = await orders.createAsGuest(dto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    expect(order.payment).toBeTruthy();
    const jwt = await access.issueSession(order);

    await expect(access.getPayment(order.publicAccessToken!, jwt)).resolves.toMatchObject({ amount: order.total });
    await expect(access.reportPayment(order.publicAccessToken!, jwt)).resolves.toMatchObject({ alreadyReported: false });
    expect(bankTransfer.reportTransfer).toHaveBeenCalledTimes(1);
    await expect(access.getPayment(other.publicAccessToken!, jwt)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(access.getPayment(order.publicAccessToken!)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('street matching', () => {
  it.each([
    ['12/3 Nguyễn Huệ', '12/3 nguyen hue', true],
    ['Số 7, Đường Trần Phú', 'so 7 duong tran phu', true],
    ['12 Nguyễn Huệ', '12/3 Nguyễn Huệ', false],
    ['', '', false],
  ])('%s vs %s → %s', (a, b, ok) => expect(streetMatches(a, b)).toBe(ok));

  it('normalizes', () => expect(normalizeStreet('  Hẻm 5/2, Lê Văn Sỹ ')).toBe('hem 5 2 le van sy'));
});
