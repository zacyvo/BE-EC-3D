import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema, OrderStatus } from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from './schemas/order-version.schema';
import { OrdersService } from './orders.service';
import { AuditService } from '../audit/audit.service';
import { NotificationJob, NotificationJobDocument, NotificationJobSchema } from '../zalo-bot/schemas/notification-job.schema';
import {
  ZaloBotRecipient,
  ZaloBotRecipientDocument,
  ZaloBotRecipientSchema,
} from '../zalo-bot/schemas/zalo-bot-recipient.schema';
import { ZaloBotConfigService } from '../zalo-bot/zalo-bot.config';
import { ZaloBotClient } from '../zalo-bot/zalo-bot.client';
import { ZaloOwnerRecipientService } from '../zalo-bot/zalo-owner-recipient.service';
import { OrderNotificationService } from '../zalo-bot/order-notification.service';
import { NotificationEventType, NotificationStatus } from '../zalo-bot/zalo-bot.constants';

/**
 * Customer cancel / cancel-request over a real (in-memory) MongoDB, including the owner's
 * ORDER_CANCEL_REQUESTED Zalo Bot notification (Zalo HTTP mocked).
 */
jest.setTimeout(60_000);

const OWNER = 'owner-chat-aaaa1111';
const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;

function build() {
  const cfg = new ZaloBotConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const recipients = new ZaloOwnerRecipientService(RecipientModel, cfg, audit);
  const notifications = new OrderNotificationService(OrderModel, JobModel, cfg, new ZaloBotClient(cfg), recipients, audit);
  jest.spyOn(notifications, 'kick').mockImplementation(() => undefined);
  const users = { findById: jest.fn(async () => ({ name: 'Trần Thị B' })) };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    {} as never,
    {} as never,
    audit,
    {} as never,
    users as never,
    {} as never,
    notifications,
  );
  return { orders, notifications };
}

async function seedOrder(status: OrderStatus, owner = userId) {
  return OrderModel.create({
    userId: new Types.ObjectId(owner),
    items: [{ productId: new Types.ObjectId(), productName: 'Đèn', productImage: 'x', productSlug: 'den', quantity: 1, unitPrice: 259000, subtotal: 259000 }],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    subtotal: 259000,
    total: 259000,
    status,
  });
}

function sentTexts(): string[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).text);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  JobModel = conn.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
  RecipientModel = conn.model(ZaloBotRecipient.name, ZaloBotRecipientSchema) as unknown as Model<ZaloBotRecipientDocument>;
  await Promise.all([OrderModel.init(), JobModel.init(), RecipientModel.init(), VersionModel.init()]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([OrderModel.deleteMany({}), VersionModel.deleteMany({}), JobModel.deleteMany({}), RecipientModel.deleteMany({})]);
  env = {
    ZALO_BOT_ENABLED: 'true',
    ZALO_BOT_TOKEN: '999:integration_test_token',
    ZALO_OWNER_CHAT_IDS: OWNER,
    ZALO_BOT_REQUEST_TIMEOUT_MS: '1000',
    ADMIN_URL: 'https://admin.luxe-glow.vn',
  };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify({ ok: true, result: { message_id: 'm1' } }), { status: 200 }),
  );
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('Customer cancels a PENDING order', () => {
  it('cancels it, records the reason and a version, sends no owner notification', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PENDING);
    const res = await svc.orders.cancelByUser(order._id.toString(), userId, '  Đặt nhầm  ');
    expect(res.status).toBe(OrderStatus.CANCELLED);
    expect(res.cancelReason).toBe('Đặt nhầm');
    expect(await VersionModel.countDocuments({ orderId: order._id })).toBe(1);
    await svc.notifications.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a default reason when none is given', async () => {
    const order = await seedOrder(OrderStatus.PENDING);
    const res = await build().orders.cancelByUser(order._id.toString(), userId);
    expect(res.cancelReason).toBe('Khách hàng tự hủy đơn');
  });

  it.each([OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
    'refuses to cancel a %s order directly',
    async (status) => {
      const order = await seedOrder(status);
      await expect(build().orders.cancelByUser(order._id.toString(), userId)).rejects.toBeInstanceOf(BadRequestException);
      expect((await OrderModel.findById(order._id).lean())?.status).toBe(status);
    },
  );

  it("refuses another user's order", async () => {
    const order = await seedOrder(OrderStatus.PENDING, otherUserId);
    await expect(build().orders.cancelByUser(order._id.toString(), userId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Customer requests cancellation of a CONFIRMED/PROCESSING order', () => {
  it.each([OrderStatus.CONFIRMED, OrderStatus.PROCESSING])(
    '%s → request saved, status unchanged, owner gets exactly one Zalo message with name, code and admin link',
    async (status) => {
      const svc = build();
      const order = await seedOrder(status);
      const id = order._id.toString();
      const res = await svc.orders.requestCancelByUser(id, userId, 'Muốn đổi mẫu');
      expect(res.status).toBe(status);
      expect(res.cancelRequest).toMatchObject({ reason: 'Muốn đổi mẫu', requestedByName: 'Trần Thị B' });
      expect(JSON.parse(JSON.stringify(res))).not.toHaveProperty('pendingNotificationEvents');

      await svc.notifications.runOnce();
      await svc.notifications.runOnce();
      const jobs = await JobModel.find().lean();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        eventType: NotificationEventType.ORDER_CANCEL_REQUESTED,
        recipientId: OWNER,
        status: NotificationStatus.ACCEPTED,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const text = sentTexts()[0];
      expect(text).toContain(`Trần Thị B yêu cầu hủy đơn hàng #${id.slice(-8).toUpperCase()}`);
      expect(text).toContain(`https://admin.luxe-glow.vn/orders?search=${id}`);
      expect(text).toContain('Lý do: Muốn đổi mẫu');
      expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual([]);
    },
  );

  it('a second request is refused and does not notify again', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.CONFIRMED);
    await svc.orders.requestCancelByUser(order._id.toString(), userId);
    await expect(svc.orders.requestCancelByUser(order._id.toString(), userId)).rejects.toThrow('đã gửi yêu cầu hủy');
    await svc.notifications.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([OrderStatus.PENDING, OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
    'refuses a request for a %s order',
    async (status) => {
      const order = await seedOrder(status);
      await expect(build().orders.requestCancelByUser(order._id.toString(), userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((await OrderModel.findById(order._id).lean())?.cancelRequest).toBeUndefined();
    },
  );

  it('bot disabled → request still saved, nothing queued', async () => {
    env.ZALO_BOT_ENABLED = 'false';
    const svc = build();
    const order = await seedOrder(OrderStatus.CONFIRMED);
    const res = await svc.orders.requestCancelByUser(order._id.toString(), userId);
    expect(res.cancelRequest).toBeDefined();
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toBeUndefined();
  });
});

describe('Customer order list', () => {
  it('filters by status and paginates newest first', async () => {
    const svc = build();
    for (let i = 0; i < 3; i++) await seedOrder(OrderStatus.PENDING);
    await seedOrder(OrderStatus.DELIVERED);
    await seedOrder(OrderStatus.PENDING, otherUserId);

    const page1 = await svc.orders.findByUser(userId, { page: 1, limit: 2, status: OrderStatus.PENDING });
    expect(page1.total).toBe(3);
    expect(page1.data).toHaveLength(2);
    const page2 = await svc.orders.findByUser(userId, { page: 2, limit: 2, status: OrderStatus.PENDING });
    expect(page2.data).toHaveLength(1);
    const ids = [...page1.data, ...page2.data].map((o) => o._id.toString());
    expect(new Set(ids).size).toBe(3);

    expect((await svc.orders.findByUser(userId, { page: 1, limit: 10 })).total).toBe(4);
  });
});
