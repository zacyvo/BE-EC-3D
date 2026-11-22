import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema, OrderStatus } from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from './schemas/order-version.schema';
import { OrdersService } from './orders.service';
import { OrderPublicAccessService } from './order-public-access.service';
import { AuditService } from '../audit/audit.service';
import { normalizeAccessPhone } from './order-public-access.util';

/**
 * "Link xem đơn" over a real (in-memory) MongoDB: an admin-created order gets a secret link +
 * security code; the customer unlocks it with phone + code (no login), wrong guesses lock it,
 * the admin re-reveals / re-issues with their password, and the public view leaks nothing internal.
 */
jest.setTimeout(60_000);

const STAFF_ID = new Types.ObjectId().toString();
const PASSWORD = 'staff-pass';
const env: Record<string, string> = { JWT_SECRET: 'test-secret', FRONTEND_URL: 'https://shop.test/' };

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
const usersById = new Map<string, { _id: Types.ObjectId; name: string; phone?: string }>();

function build() {
  const config = { get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const users = {
    findById: jest.fn(async (id: string) => usersById.get(id) ?? null),
    findOrCreateByPhone: jest.fn(async (phone: string, name: string) => {
      const user = { _id: new Types.ObjectId(), name, phone };
      usersById.set(user._id.toString(), user);
      return { user, created: true };
    }),
  };
  const products = {
    findById: jest.fn(async () => ({ name: 'Đèn ngủ 3D', slug: 'den-ngu', stock: 10, images: ['img.png'], price: 259000, finalPrice: 259000, colors: [], sizes: [] })),
  };
  const staff = { verifyPassword: jest.fn(async (_id: string, pw: string) => pw === PASSWORD) };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    products as never,
    {} as never,
    audit,
    {} as never,
    users as never,
    {} as never,
    {} as never,
  );
  // createForAdmin resolves the variant/shipping through these — keep them out of the way here.
  jest.spyOn(orders, 'resolveVariant').mockReturnValue({ image: 'img.png' });
  jest.spyOn(orders, 'resolveShippingInfo').mockImplementation((s) => s as never);
  const access = new OrderPublicAccessService(
    OrderModel,
    new JwtService({}),
    config,
    staff as never,
    users as never,
    audit,
  );
  return { orders, access, audit };
}

const shippingInfo = { recipientName: 'Người nhận', phone: '0987654321', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' };

async function createGuestOrder(orders: OrdersService) {
  return orders.createForAdmin(STAFF_ID, {
    guestInfo: { phone: '0912345678', name: 'Khách A' },
    items: [{ productId: new Types.ObjectId().toString(), quantity: 2 }],
    shippingInfo,
    adminNote: 'Nội bộ: khách quen, chiết khấu riêng',
    customerNote: 'Gói quà giúp em',
    shippingFee: 22000,
  } as never);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  await OrderModel.syncIndexes();
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await OrderModel.deleteMany({});
  await VersionModel.deleteMany({});
  usersById.clear();
});

describe('issue on admin create', () => {
  it('gives an admin-created order a link + code tied to the account phone, hidden from JSON', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);

    const creds = access.credentialsOfNewOrder(order)!;
    expect(creds.publicUrl).toMatch(/^https:\/\/shop\.test\/order\/[a-f0-9]{48}$/);
    expect(creds.securityCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(creds.phone).toBe('0912345678');

    const json = JSON.parse(JSON.stringify(order));
    expect(json.publicAccessCode).toBeUndefined();
    const fresh = await OrderModel.findById(order._id).exec();
    expect(fresh!.publicAccessCode).toBeUndefined(); // select: false
    expect(fresh!.publicAccessToken).toBe(order.publicAccessToken);

    // Neither the version history nor the admin search (aggregation) may carry the code.
    const version = await VersionModel.findOne({ orderId: order._id }).lean().exec();
    expect(version).toBeTruthy();
    expect(JSON.stringify(version)).not.toContain(creds.securityCode);
    const found = await orders.findAllAdmin({ page: 1, limit: 10, search: order._id.toString() });
    expect(found.data).toHaveLength(1);
    expect(JSON.stringify(found.data)).not.toContain(creds.securityCode);
    expect((found.data[0] as Record<string, unknown>).publicAccessToken).toBe(order.publicAccessToken);
  });
});

describe('customer unlock', () => {
  it('opens the order with phone (any format) + code and returns only the public view', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);
    const { securityCode } = access.credentialsOfNewOrder(order)!;
    const token = order.publicAccessToken!;

    expect(await access.getMeta(token)).toEqual({
      orderCode: order._id.toString().slice(-8).toUpperCase(),
      maskedPhone: '091****678',
    });

    const res = await access.verify(token, '+84 912 345 678', ` ${securityCode.toLowerCase()} `);
    expect(res.order.total).toBe(259000 * 2 + 22000);
    expect(res.order.customerNote).toBe('Gói quà giúp em');
    const raw = JSON.stringify(res.order);
    for (const secret of ['adminNote', 'Nội bộ', 'createdByStaffId', 'userId', 'publicAccess', STAFF_ID]) {
      expect(raw).not.toContain(secret);
    }

    const view = await access.getOrder(token, res.accessJwt);
    expect(view.status).toBe(OrderStatus.PENDING);
    expect(view.items).toHaveLength(1);
  });

  it('rejects a wrong phone or code and locks after 5 misses — even the right code', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);
    const { securityCode } = access.credentialsOfNewOrder(order)!;
    const token = order.publicAccessToken!;

    await expect(access.verify(token, '0987654321', securityCode)).rejects.toBeInstanceOf(UnauthorizedException);
    for (let i = 0; i < 4; i++) {
      await expect(access.verify(token, '0912345678', 'WRONGCOD')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(access.verify(token, '0912345678', securityCode)).rejects.toBeInstanceOf(ForbiddenException);

    // Lock expired → right credentials work again and the counters are cleared.
    await OrderModel.updateOne({ _id: order._id }, { $set: { publicAccessLockedUntil: new Date(Date.now() - 1000) } });
    await expect(access.verify(token, '0912345678', securityCode)).resolves.toHaveProperty('accessJwt');
    const after = await OrderModel.findById(order._id).lean().exec();
    expect(after!.publicAccessAttempts).toBeUndefined();
    expect(after!.publicAccessLockedUntil).toBeUndefined();
  });

  it('refuses unknown tokens, missing/foreign sessions', async () => {
    const { orders, access } = build();
    const a = await createGuestOrder(orders);
    const b = await createGuestOrder(orders);
    const credsA = access.credentialsOfNewOrder(a)!;

    await expect(access.getMeta('not-a-token')).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.getMeta('a'.repeat(48))).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.getOrder(a.publicAccessToken!)).rejects.toBeInstanceOf(UnauthorizedException);

    const { accessJwt } = await access.verify(a.publicAccessToken!, '0912345678', credsA.securityCode);
    await expect(access.getOrder(b.publicAccessToken!, accessJwt)).rejects.toBeInstanceOf(UnauthorizedException);
    // A storefront login JWT (no typ) can't be replayed here either.
    const loginJwt = await new JwtService({}).signAsync({ sub: a._id.toString() }, { secret: env.JWT_SECRET });
    await expect(access.getOrder(a.publicAccessToken!, loginJwt)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not open a soft-deleted order', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);
    await OrderModel.updateOne({ _id: order._id }, { $set: { isDeleted: true } });
    await expect(access.getMeta(order.publicAccessToken!)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('admin reveal / re-issue', () => {
  it('needs the staff password; reveal returns the same code', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);
    const original = access.credentialsOfNewOrder(order)!;

    await expect(access.revealOrIssue(order._id.toString(), STAFF_ID, 'nope')).rejects.toBeInstanceOf(UnauthorizedException);
    const revealed = await access.revealOrIssue(order._id.toString(), STAFF_ID, PASSWORD);
    expect(revealed).toMatchObject({ publicUrl: original.publicUrl, securityCode: original.securityCode });
  });

  it('re-issuing changes link + code and ends sessions opened with the old link', async () => {
    const { orders, access } = build();
    const order = await createGuestOrder(orders);
    const old = access.credentialsOfNewOrder(order)!;
    const oldToken = order.publicAccessToken!;
    const { accessJwt } = await access.verify(oldToken, '0912345678', old.securityCode);

    const fresh = await access.revealOrIssue(order._id.toString(), STAFF_ID, PASSWORD, true);
    expect(fresh.publicUrl).not.toBe(old.publicUrl);
    await expect(access.getMeta(oldToken)).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.getOrder(oldToken, accessJwt)).rejects.toBeInstanceOf(NotFoundException);

    const newToken = fresh.publicUrl.split('/').pop()!;
    await expect(access.getOrder(newToken, accessJwt)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(access.verify(newToken, '0912345678', fresh.securityCode)).resolves.toHaveProperty('accessJwt');
  });

  it('issues a link for an older order that had none (account phone, else recipient phone)', async () => {
    const { access } = build();
    const user = { _id: new Types.ObjectId(), name: 'Khách cũ' }; // no phone on the account
    usersById.set(user._id.toString(), user);
    const legacy = await OrderModel.create({
      userId: user._id,
      items: [{ productId: new Types.ObjectId(), productName: 'Đèn', productImage: 'x', productSlug: 'den', quantity: 1, unitPrice: 100000, subtotal: 100000 }],
      shippingInfo,
      subtotal: 100000,
      total: 100000,
      createdByAdmin: true,
    });
    const creds = await access.revealOrIssue(legacy._id.toString(), STAFF_ID, PASSWORD);
    expect(creds.phone).toBe('0987654321');
    const token = creds.publicUrl.split('/').pop()!;
    await expect(access.verify(token, '0987654321', creds.securityCode)).resolves.toHaveProperty('accessJwt');
  });

  it('refuses marketplace orders (masked phone)', async () => {
    const { access } = build();
    const shopee = await OrderModel.create({
      userId: new Types.ObjectId(),
      items: [{ productId: new Types.ObjectId(), productName: 'Đèn', productImage: 'x', productSlug: 'den', quantity: 1, unitPrice: 100000, subtotal: 100000 }],
      shippingInfo: { ...shippingInfo, phone: '******321' },
      subtotal: 100000,
      total: 100000,
      externalRef: { channel: 'SHOPEE', code: '2611ABC' },
    });
    await expect(access.revealOrIssue(shopee._id.toString(), STAFF_ID, PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('normalizeAccessPhone', () => {
  it.each([
    ['0912345678', '0912345678'],
    ['+84912345678', '0912345678'],
    ['84 912.345.678', '0912345678'],
    ['0912 345 678', '0912345678'],
  ])('%s → %s', (input, out) => expect(normalizeAccessPhone(input)).toBe(out));
});
