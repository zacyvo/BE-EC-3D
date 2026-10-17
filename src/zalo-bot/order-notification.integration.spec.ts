import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto } from '../orders/dto/order.dto';
import { AuditService } from '../audit/audit.service';
import { NotificationJob, NotificationJobDocument, NotificationJobSchema } from './schemas/notification-job.schema';
import {
  ZaloBotRecipient,
  ZaloBotRecipientDocument,
  ZaloBotRecipientSchema,
  ZaloBotRecipientStatus,
} from './schemas/zalo-bot-recipient.schema';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotClient } from './zalo-bot.client';
import { ZaloOwnerRecipientService } from './zalo-owner-recipient.service';
import { OrderNotificationService } from './order-notification.service';
import { NO_RECIPIENT_PLACEHOLDER, NotificationStatus } from './zalo-bot.constants';

/**
 * End-to-end over a real (in-memory) MongoDB: real OrdersService.create() → outbox flag →
 * worker fan-out → mocked Zalo HTTP → persisted outcome. Only external collaborators of
 * checkout (products/cart/promotions/users/address) and the Zalo network are stubbed.
 */
jest.setTimeout(60_000);

const TOKEN = '999:integration_test_token';
const OWNER_A = 'owner-chat-aaaa1111';
const OWNER_B = 'owner-chat-bbbb2222';
const OWNER_C = 'owner-chat-cccc3333';

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;

const productId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();
let product: { stock: number; finalPrice: number };

function okResponse(messageId = 'msg-1'): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId, date: Date.now() } }), { status: 200 });
}
function errorResponse(status: number, code = status, description = 'error'): Response {
  return new Response(JSON.stringify({ ok: false, error_code: code, description }), { status });
}
function hangUntilAborted() {
  return (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
}
function sentChatIds(): string[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).chat_id);
}

function build() {
  const cfg = new ZaloBotConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const client = new ZaloBotClient(cfg);
  const recipients = new ZaloOwnerRecipientService(RecipientModel, cfg, audit);
  const notifications = new OrderNotificationService(OrderModel, JobModel, cfg, client, recipients, audit);
  const cart = { clearCart: jest.fn().mockResolvedValue(undefined) };
  const products = {
    findById: jest.fn(async () => ({
      _id: productId,
      name: 'Đèn ngủ 3D',
      slug: 'den-ngu-3d',
      stock: product.stock,
      finalPrice: product.finalPrice,
      colors: [],
      sizes: [],
      images: ['https://img/1.jpg'],
    })),
  };
  const promotions = { validateCoupons: jest.fn(), markUsed: jest.fn() };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    products as never,
    cart as never,
    audit,
    promotions as never,
    {} as never,
    {} as never,
    notifications,
  );
  return { cfg, recipients, notifications, orders, cart };
}

const checkoutDto = (): CreateOrderDto =>
  ({
    items: [{ productId, quantity: 2 }],
    shippingInfo: { recipientName: 'Nguyễn Văn A', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
  }) as CreateOrderDto;

async function createOrder(svc: ReturnType<typeof build>) {
  return svc.orders.create(userId, checkoutDto());
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  JobModel = conn.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
  RecipientModel = conn.model(ZaloBotRecipient.name, ZaloBotRecipientSchema) as unknown as Model<ZaloBotRecipientDocument>;
  // Build indexes up front — the unique dedupKey index is part of what's under test.
  await Promise.all([OrderModel.init(), JobModel.init(), RecipientModel.init(), VersionModel.init()]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([
    OrderModel.deleteMany({}),
    VersionModel.deleteMany({}),
    JobModel.deleteMany({}),
    RecipientModel.deleteMany({}),
  ]);
  env = {
    ZALO_BOT_ENABLED: 'true',
    ZALO_BOT_TOKEN: TOKEN,
    ZALO_OWNER_CHAT_IDS: OWNER_A,
    ZALO_BOT_REQUEST_TIMEOUT_MS: '1000',
    ZALO_BOT_RETRY_BASE_DELAY_MS: '60000',
    ZALO_BOT_MAX_RETRIES: '3',
    ADMIN_URL: 'https://admin.luxe-glow.vn',
  };
  product = { stock: 10, finalPrice: 129500 };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => okResponse());
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

/** Most tests drive the worker explicitly; kick() would otherwise run it in the background. */
function buildQuiet() {
  const svc = build();
  jest.spyOn(svc.notifications, 'kick').mockImplementation(() => undefined);
  return svc;
}

describe('ORDER_CREATED → Zalo Bot (integration)', () => {
  it('TEST 01: bot disabled → checkout unchanged, nothing queued or sent', async () => {
    env.ZALO_BOT_ENABLED = 'false';
    const svc = buildQuiet();
    const order = await createOrder(svc);
    expect(order._id).toBeDefined();
    expect(svc.cart.clearCart).toHaveBeenCalled();
    const saved = await OrderModel.findById(order._id).lean();
    expect(saved?.pendingNotificationEvents).toBeUndefined();
    await svc.notifications.runOnce();
    expect(await JobModel.countDocuments()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEST 02: enabled but token missing → checkout OK, notification SKIPPED_NOT_CONFIGURED', async () => {
    env.ZALO_BOT_TOKEN = '';
    const svc = buildQuiet();
    const order = await createOrder(svc);
    await svc.notifications.runOnce();
    const jobs = await JobModel.find().lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: NotificationStatus.SKIPPED_NOT_CONFIGURED,
      recipientId: NO_RECIPIENT_PLACEHOLDER,
      lastErrorCode: 'CONFIG_INVALID',
    });
    expect(jobs[0].orderId.toString()).toBe(order._id.toString());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEST 03: enabled but no chat id → skipped safely; admin retry after configuring sends once', async () => {
    env.ZALO_OWNER_CHAT_IDS = '';
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    const placeholder = await JobModel.findOne().lean();
    expect(placeholder).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'NO_APPROVED_RECIPIENT' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Retrying while still unconfigured is refused (no silent no-op).
    await expect(svc.notifications.retryJob(placeholder!._id.toString(), 'staff-1')).rejects.toBeInstanceOf(BadRequestException);

    env.ZALO_OWNER_CHAT_IDS = OWNER_A;
    const res = await svc.notifications.retryJob(placeholder!._id.toString(), 'staff-1');
    expect(res).toEqual({ mode: 'fanned_out', jobs: 1 });
    await svc.notifications.runOnce();
    const jobs = await JobModel.find().lean();
    expect(jobs).toHaveLength(1); // placeholder superseded
    expect(jobs[0]).toMatchObject({ recipientId: OWNER_A, status: NotificationStatus.ACCEPTED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TEST 04 + 06: valid order → exactly one job, sent with real order data, message_id saved', async () => {
    fetchMock.mockImplementation(async () => okResponse('82599fa32f56d00e8941'));
    const svc = buildQuiet();
    const order = await createOrder(svc);

    // Outbox intent persisted in the same document, hidden from the API response.
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual(['ORDER_CREATED']);
    expect(JSON.parse(JSON.stringify(order))).not.toHaveProperty('pendingNotificationEvents');
    expect(fetchMock).not.toHaveBeenCalled(); // nothing sent synchronously during checkout

    const pass = await svc.notifications.runOnce();
    expect(pass).toMatchObject({ fannedOut: 1, processed: 1 });

    const jobs = await JobModel.find().lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: NotificationStatus.ACCEPTED,
      providerMessageId: '82599fa32f56d00e8941',
      recipientId: OWNER_A,
      recipientSource: 'ENV',
      attemptCount: 1,
    });
    expect(jobs[0].acceptedAt).toBeInstanceOf(Date);
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://bot-api.zaloplatforms.com/bot${TOKEN}/sendMessage`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe(OWNER_A);
    expect(body.text).toContain(`#${order._id.toString().slice(-8).toUpperCase()}`);
    expect(body.text).toContain('Đèn ngủ 3D x 2 — 259.000đ');
    expect(body.text).toContain('Tổng tiền: 259.000đ');
    expect(body.text).toContain('SĐT: 09******89');
    expect(body.text).toContain('Chưa thanh toán');
    expect(body.text).toContain(`https://admin.luxe-glow.vn/orders?search=${order._id}`);
  });

  it('TEST 05: failed order persistence / validation → no notification', async () => {
    const svc = buildQuiet();
    product = { stock: 0, finalPrice: 100000 }; // rejected before insert
    await expect(createOrder(svc)).rejects.toThrow(/Insufficient stock/);
    product = { stock: 10, finalPrice: -1 }; // insert itself fails (total min: 0)
    await expect(createOrder(svc)).rejects.toThrow(/validation failed/i);

    expect(await OrderModel.countDocuments()).toBe(0);
    await svc.notifications.runOnce();
    expect(await JobModel.countDocuments()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEST 07: Zalo ok=false → FAILED recorded with provider error', async () => {
    fetchMock.mockImplementation(async () => errorResponse(403, 403, 'Bot is blocked by user'));
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    const job = await JobModel.findOne().lean();
    expect(job).toMatchObject({
      status: NotificationStatus.FAILED,
      lastErrorCode: 'ZALO_403',
      lastErrorMessage: 'Bot is blocked by user',
      lastHttpStatus: 403,
      attemptCount: 1,
    });
    expect(job?.processedAt).toBeInstanceOf(Date);
  });

  it('TEST 08: Zalo timeout → checkout still succeeds immediately; outcome UNKNOWN', async () => {
    fetchMock.mockImplementation(hangUntilAborted());
    const svc = build(); // real kick(): worker runs in the background
    const started = Date.now();
    const order = await createOrder(svc);
    expect(Date.now() - started).toBeLessThan(900); // did not wait for the 1000ms Zalo timeout
    expect(order._id).toBeDefined();

    await new Promise((r) => setImmediate(r));
    await svc.notifications.runOnce(); // joins the in-flight background pass
    const job = await JobModel.findOne().lean();
    expect(job).toMatchObject({ status: NotificationStatus.UNKNOWN, lastErrorCode: 'TIMEOUT' });
    expect(await OrderModel.countDocuments()).toBe(1);
  });

  it('TEST 09: duplicate ORDER_CREATED event → still one job, one send', async () => {
    const svc = buildQuiet();
    const order = await createOrder(svc);
    await svc.notifications.runOnce();

    // Same event re-emitted twice (re-flagged order + direct fan-out).
    await OrderModel.updateOne({ _id: order._id }, { $addToSet: { pendingNotificationEvents: 'ORDER_CREATED' } });
    await svc.notifications.fanOutOrder(order._id.toString(), 'ORDER_CREATED' as never);
    await svc.notifications.runOnce();

    expect(await JobModel.countDocuments()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TEST 10: several worker instances in parallel → no duplicate sends', async () => {
    env.ZALO_OWNER_CHAT_IDS = [OWNER_A, OWNER_B, OWNER_C].join(',');
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return okResponse();
    });
    const producer = buildQuiet();
    await createOrder(producer);
    await createOrder(producer);

    const workers = [buildQuiet(), buildQuiet(), buildQuiet(), buildQuiet()];
    expect(new Set(workers.map((w) => w.notifications.workerId)).size).toBe(4);
    await Promise.all(workers.map((w) => w.notifications.runOnce()));
    await Promise.all(workers.map((w) => w.notifications.runOnce()));

    expect(await JobModel.countDocuments()).toBe(6); // 2 orders × 3 owners
    expect(await JobModel.countDocuments({ status: NotificationStatus.ACCEPTED })).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const counts = sentChatIds().reduce<Record<string, number>>((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), {});
    expect(counts).toEqual({ [OWNER_A]: 2, [OWNER_B]: 2, [OWNER_C]: 2 });
  });

  it('TEST 11: multiple approved owners (ENV + DB) → independent jobs and outcomes', async () => {
    env.ZALO_OWNER_CHAT_IDS = `${OWNER_A},${OWNER_B}`;
    const now = new Date();
    await RecipientModel.create({ chatId: OWNER_C, status: ZaloBotRecipientStatus.APPROVED, firstSeenAt: now, lastSeenAt: now, displayName: 'Quản lý' });
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      JSON.parse(init.body as string).chat_id === OWNER_B ? errorResponse(400, 400, 'invalid chat') : okResponse(),
    );
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();

    const jobs = await JobModel.find().sort({ recipientId: 1 }).lean();
    expect(jobs.map((j) => [j.recipientId, j.recipientSource, j.status])).toEqual([
      [OWNER_A, 'ENV', NotificationStatus.ACCEPTED],
      [OWNER_B, 'ENV', NotificationStatus.FAILED],
      [OWNER_C, 'DB', NotificationStatus.ACCEPTED],
    ]);
  });

  it('TEST 18: chats discovered via webhook stay PENDING and never receive notifications', async () => {
    const svc = buildQuiet();
    expect(await svc.recipients.recordInboundChat({ chatId: 'stranger-1', chatType: 'PRIVATE', displayName: 'Ai đó' })).toBe('created');
    expect(await svc.recipients.recordInboundChat({ chatId: 'stranger-1', displayName: 'Ai đó' })).toBe('updated');
    expect(await RecipientModel.countDocuments()).toBe(1);
    expect((await RecipientModel.findOne().lean())?.status).toBe(ZaloBotRecipientStatus.PENDING);
    expect(await svc.recipients.isApproved('stranger-1')).toBe(false);

    await createOrder(svc);
    await svc.notifications.runOnce();
    expect(sentChatIds()).toEqual([OWNER_A]);

    // Explicit SUPER_ADMIN approval is the only way in.
    const row = await RecipientModel.findOne({ chatId: 'stranger-1' });
    await svc.recipients.approve(row!._id.toString(), 'staff-1');
    expect(await svc.recipients.isApproved('stranger-1')).toBe(true);
    // Another inbound message doesn't change the approved status either way.
    await svc.recipients.recordInboundChat({ chatId: 'stranger-1' });
    expect((await RecipientModel.findOne({ chatId: 'stranger-1' }).lean())?.status).toBe(ZaloBotRecipientStatus.APPROVED);
  });

  it('caps the number of pending (unapproved) chats a stranger can create', async () => {
    const svc = buildQuiet();
    for (let i = 0; i < 20; i++) await svc.recipients.recordInboundChat({ chatId: `spam-${i}` });
    expect(await svc.recipients.recordInboundChat({ chatId: 'spam-overflow' })).toBe('ignored_limit');
    expect(await RecipientModel.countDocuments()).toBe(20);
  });

  it('revoked between fan-out and send → skipped, not sent', async () => {
    env.ZALO_OWNER_CHAT_IDS = '';
    const now = new Date();
    const row = await RecipientModel.create({ chatId: OWNER_C, status: ZaloBotRecipientStatus.APPROVED, firstSeenAt: now, lastSeenAt: now });
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.fanOutPendingOrders();
    await svc.recipients.revoke(row._id.toString(), 'staff-1');
    await svc.notifications.runOnce();
    expect(await JobModel.findOne().lean()).toMatchObject({
      status: NotificationStatus.SKIPPED_NOT_CONFIGURED,
      lastErrorCode: 'RECIPIENT_NOT_APPROVED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEST 19: transient error → exponential backoff, bounded retries, then FAILED', async () => {
    env.ZALO_BOT_MAX_RETRIES = '2'; // 3 attempts total
    fetchMock.mockImplementation(async () => new Response('Service Unavailable', { status: 503 }));
    const svc = buildQuiet();
    await createOrder(svc);

    const t0 = Date.now();
    await svc.notifications.runOnce();
    let job = await JobModel.findOne().lean();
    expect(job).toMatchObject({ status: NotificationStatus.RETRY_PENDING, attemptCount: 1, lastErrorCode: 'HTTP_503' });
    const delay1 = job!.nextAttemptAt.getTime() - t0;
    expect(delay1).toBeGreaterThanOrEqual(59_000);
    expect(delay1).toBeLessThan(65_000);

    await svc.notifications.runOnce(); // not due yet → not retried
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await JobModel.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    const t1 = Date.now();
    await svc.notifications.runOnce();
    job = await JobModel.findOne().lean();
    expect(job).toMatchObject({ status: NotificationStatus.RETRY_PENDING, attemptCount: 2 });
    expect(job!.nextAttemptAt.getTime() - t1).toBeGreaterThanOrEqual(119_000); // 2 × base

    await JobModel.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    await svc.notifications.runOnce();
    job = await JobModel.findOne().lean();
    expect(job).toMatchObject({ status: NotificationStatus.FAILED, attemptCount: 3 });
    expect(job!.attempts.map((a) => a.outcome)).toEqual(['TRANSIENT', 'TRANSIENT', 'TRANSIENT']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('TEST 19b: transient failure followed by success → ACCEPTED on retry', async () => {
    fetchMock
      .mockImplementationOnce(async () => errorResponse(429, 429, 'Too many requests'))
      .mockImplementationOnce(async () => okResponse('after-retry'));
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    await JobModel.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    await svc.notifications.runOnce();
    expect(await JobModel.findOne().lean()).toMatchObject({
      status: NotificationStatus.ACCEPTED,
      providerMessageId: 'after-retry',
      attemptCount: 2,
    });
  });

  it('TEST 20: permanent error → no automatic retry', async () => {
    fetchMock.mockImplementation(async () => errorResponse(401, 401, 'Unauthorized'));
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    await JobModel.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    await svc.notifications.runOnce();
    expect(await JobModel.findOne().lean()).toMatchObject({ status: NotificationStatus.FAILED, attemptCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TEST 21: unknown outcome after timeout → never auto-resent; manual retry needs confirmation', async () => {
    fetchMock.mockImplementationOnce(hangUntilAborted());
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    const job = await JobModel.findOne().lean();
    expect(job).toMatchObject({ status: NotificationStatus.UNKNOWN, lastErrorCode: 'TIMEOUT' });

    await JobModel.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    await svc.notifications.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no blind resend

    await expect(svc.notifications.retryJob(job!._id.toString(), 'staff-1')).rejects.toThrow(/không xác định/);
    expect(await svc.notifications.retryJob(job!._id.toString(), 'staff-1', true)).toEqual({ mode: 'requeued' });
    await svc.notifications.runOnce();
    expect(await JobModel.findOne().lean()).toMatchObject({ status: NotificationStatus.ACCEPTED, attemptCount: 2, maxAttempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('TEST 21b: worker died mid-send (expired lease) → UNKNOWN, not resent', async () => {
    const svc = buildQuiet();
    const order = await createOrder(svc);
    await svc.notifications.fanOutPendingOrders();
    await JobModel.updateOne(
      { orderId: order._id },
      { $set: { status: NotificationStatus.PROCESSING, lockOwner: 'dead-worker', lockedUntil: new Date(Date.now() - 1000) }, $inc: { attemptCount: 1 } },
    );
    const pass = await svc.notifications.runOnce();
    expect(pass.recovered).toBe(1);
    expect(await JobModel.findOne().lean()).toMatchObject({ status: NotificationStatus.UNKNOWN, lastErrorCode: 'WORKER_LEASE_EXPIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin list masks chat ids and flags retryable rows', async () => {
    fetchMock.mockImplementation(async () => errorResponse(400));
    const svc = buildQuiet();
    const order = await createOrder(svc);
    await svc.notifications.runOnce();
    const list = await svc.notifications.listJobs({ orderId: order._id.toString(), page: 1, limit: 20 });
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({ status: NotificationStatus.FAILED, retryable: true, orderCode: expect.stringMatching(/^#/) });
    expect(JSON.stringify(list)).not.toContain(OWNER_A);
    expect(await svc.notifications.statusCounts()).toEqual({ FAILED: 1 });
  });

  it('accepted jobs cannot be retried (prevents spamming the owner)', async () => {
    const svc = buildQuiet();
    await createOrder(svc);
    await svc.notifications.runOnce();
    const job = await JobModel.findOne().lean();
    await expect(svc.notifications.retryJob(job!._id.toString(), 'staff-1', true)).rejects.toBeInstanceOf(BadRequestException);
  });
});
