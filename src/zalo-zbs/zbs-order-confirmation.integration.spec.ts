import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema, OrderStatus } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto, UpdateOrderStatusDto } from '../orders/dto/order.dto';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';
import { NotificationJob, NotificationJobDocument, NotificationJobSchema } from '../zalo-bot/schemas/notification-job.schema';
import { ZaloBotRecipient, ZaloBotRecipientDocument, ZaloBotRecipientSchema } from '../zalo-bot/schemas/zalo-bot-recipient.schema';
import { ZaloBotConfigService } from '../zalo-bot/zalo-bot.config';
import { ZaloBotClient } from '../zalo-bot/zalo-bot.client';
import { ZaloOwnerRecipientService } from '../zalo-bot/zalo-owner-recipient.service';
import { OrderNotificationService } from '../zalo-bot/order-notification.service';
import { NotificationStatus } from '../zalo-bot/zalo-bot.constants';
import { ZbsCredential, ZbsCredentialDocument, ZbsCredentialSchema } from './schemas/zbs-credential.schema';
import {
  ZbsTemplateVerification,
  ZbsTemplateVerificationDocument,
  ZbsTemplateVerificationSchema,
} from './schemas/zbs-template-verification.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { ZbsOrderConfirmationService } from './zbs-order-confirmation.service';
import { ZALO_ZBS_CHANNEL, ZBS_ORDER_OUTBOX_MARKER } from './zalo-zbs.constants';

/**
 * End-to-end over a real (in-memory) MongoDB: real OrdersService.create() → outbox markers →
 * Bot worker AND ZBS worker → mocked Zalo HTTP (Bot API, ZBS business API, OAuth) →
 * persisted outcomes. Covers the prompt's TEST 01–28 at integration level.
 */
jest.setTimeout(90_000);

const BOT_TOKEN = '999:integration_test_token';
const OWNER = 'owner-chat-aaaa1111';
const SEED_ACCESS = 'zbs-seed-access-token-0001';
const SEED_REFRESH = 'zbs-seed-refresh-token-0001';
const APP_SECRET = 'zbs-app-secret-0001';
const TEMPLATE_ID = 'tpl700001';
const CHECKOUT_PHONE = '0912345689';
const NORMALIZED_PHONE = '84912345689';
const PARAMS = { customer_name: 'customerName', order_code: 'orderCode', order_total: 'orderTotal', order_status: 'orderStatus' };
const TEMPLATE_PARAMS = Object.keys(PARAMS).map((name) => ({ name, require: true, type: 'STRING', maxLength: 50, minLength: 0, acceptNull: false }));

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let CredModel: Model<ZbsCredentialDocument>;
let TplModel: Model<ZbsTemplateVerificationDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
let logLines: string[];

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let handlers: { bot: Handler; send: Handler; info: Handler; status: Handler; oauth: Handler };

const productId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const zbsOk = (msgId = 'zbs-msg-1', remaining = '499') =>
  json({ error: 0, message: 'Success', data: { msg_id: msgId, sent_time: '1760760000000', sending_mode: '1', quota: { dailyQuota: '500', remainingQuota: remaining } } });
const zbsError = (code: number, message = 'error') => json({ error: code, message });
const templateInfo = (status = 'ENABLE', listParams = TEMPLATE_PARAMS) =>
  json({ error: 0, message: 'Success', data: { templateId: TEMPLATE_ID, templateName: 'Xác nhận đơn', status, listParams, listButtons: [], templateTag: 'TRANSACTION', price_sdt: '300' } });
function hang(_url: string, init: RequestInit) {
  return new Promise<Response>((_r, reject) =>
    init.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    }),
  );
}

function calls(prefix: string) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
}
const sendCalls = () => calls('https://zbs-mock.test/message/template');
const sentBodies = () => sendCalls().map((c) => JSON.parse((c[1] as RequestInit).body as string));
const botCalls = () => calls('https://bot-api.zaloplatforms.com');
const zbsAnyCalls = () => fetchMock.mock.calls.filter((c) => /zbs-mock|oauth-mock/.test(String(c[0])));

function build() {
  const configService = { get: (k: string) => env[k] } as unknown as ConfigService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const botCfg = new ZaloBotConfigService(configService);
  const zbsCfg = new ZaloZbsConfigService(configService);
  const zbsClient = new ZbsApiClient(zbsCfg);
  const auth = new ZbsAuthService(CredModel, zbsCfg, zbsClient);
  const zbs = new ZbsOrderConfirmationService(OrderModel, JobModel, TplModel, zbsCfg, zbsClient, auth, audit);
  const recipients = new ZaloOwnerRecipientService(RecipientModel, botCfg, audit);
  const notifications = new OrderNotificationService(OrderModel, JobModel, botCfg, new ZaloBotClient(botCfg), recipients, audit, zbs);
  const products = {
    findById: jest.fn(async () => ({ _id: productId, name: 'Đèn ngủ 3D', slug: 'den-ngu-3d', stock: 10, finalPrice: 129500, colors: [], sizes: [], images: ['https://img/1.jpg'] })),
  };
  const cart = { clearCart: jest.fn().mockResolvedValue(undefined) };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    products as never,
    cart as never,
    audit,
    { validateCoupons: jest.fn(), markUsed: jest.fn() } as never,
    {} as never,
    {} as never,
    notifications,
  );
  return { orders, notifications, zbs, auth, audit, cart };
}

/** Workers driven explicitly (kick() would run them in the background). */
function buildQuiet() {
  const svc = build();
  jest.spyOn(svc.notifications, 'kick').mockImplementation(() => undefined);
  jest.spyOn(svc.zbs, 'kick').mockImplementation(() => undefined);
  return svc;
}

const dto = (phone = CHECKOUT_PHONE): CreateOrderDto =>
  ({
    items: [{ productId, quantity: 2 }],
    shippingInfo: { recipientName: 'Nguyễn Văn A', phone, street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
  }) as CreateOrderDto;

async function runBoth(svc: ReturnType<typeof build>) {
  await Promise.all([svc.notifications.runOnce(), svc.zbs.runOnce()]);
}
const zbsJobs = () => JobModel.find({ channel: ZALO_ZBS_CHANNEL }).lean();
const botJobs = () => JobModel.find({ channel: 'ZALO_BOT' }).lean();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  JobModel = conn.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
  RecipientModel = conn.model(ZaloBotRecipient.name, ZaloBotRecipientSchema) as unknown as Model<ZaloBotRecipientDocument>;
  CredModel = conn.model(ZbsCredential.name, ZbsCredentialSchema) as unknown as Model<ZbsCredentialDocument>;
  TplModel = conn.model(ZbsTemplateVerification.name, ZbsTemplateVerificationSchema) as unknown as Model<ZbsTemplateVerificationDocument>;
  await Promise.all([OrderModel.init(), VersionModel.init(), JobModel.init(), RecipientModel.init(), CredModel.init(), TplModel.init()]);
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
    CredModel.deleteMany({}),
    TplModel.deleteMany({}),
  ]);
  env = {
    ZALO_BOT_ENABLED: 'true',
    ZALO_BOT_TOKEN: BOT_TOKEN,
    ZALO_OWNER_CHAT_IDS: OWNER,
    ZALO_BOT_REQUEST_TIMEOUT_MS: '1000',
    ZALO_BOT_RETRY_BASE_DELAY_MS: '60000',
    ADMIN_URL: 'https://admin.luxe-glow.vn',
    ZALO_ZBS_ENABLED: 'true',
    ZALO_ZBS_APP_ID: '1234567890',
    ZALO_ZBS_APP_SECRET: APP_SECRET,
    ZALO_ZBS_OA_ID: '987654321',
    ZALO_ZBS_ACCESS_TOKEN: SEED_ACCESS,
    ZALO_ZBS_REFRESH_TOKEN: SEED_REFRESH,
    ZALO_ZBS_TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
    ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION: TEMPLATE_ID,
    ZALO_ZBS_ORDER_CONFIRMATION_PARAMS: JSON.stringify(PARAMS),
    ZALO_ZBS_API_BASE_URL: 'https://zbs-mock.test',
    ZALO_ZBS_OAUTH_BASE_URL: 'https://oauth-mock.test',
    ZALO_ZBS_REQUEST_TIMEOUT_MS: '1000',
    ZALO_ZBS_RETRY_BASE_DELAY_MS: '60000',
    ZALO_ZBS_MAX_RETRIES: '2',
    FRONTEND_URL: 'https://luxe-glow.vn',
  };
  let refreshN = 0;
  handlers = {
    bot: () => json({ ok: true, result: { message_id: 'bot-msg-1', date: Date.now() } }),
    send: () => zbsOk(),
    info: () => templateInfo(),
    status: () => json({ error: 0, message: 'Success', data: { status: 1, delivery_time: '1760760100000', message: 'delivered' } }),
    oauth: () => json({ access_token: `zbs-access-rotated-${++refreshN}`, refresh_token: `zbs-refresh-rotated-${refreshN}`, expires_in: '90000' }),
  };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const i = init as RequestInit;
    if (url.startsWith('https://bot-api.zaloplatforms.com')) return handlers.bot(url, i);
    if (url.startsWith('https://zbs-mock.test/message/template')) return handlers.send(url, i);
    if (url.startsWith('https://zbs-mock.test/template/info/v2')) return handlers.info(url, i);
    if (url.startsWith('https://zbs-mock.test/message/status')) return handlers.status(url, i);
    if (url.startsWith('https://oauth-mock.test/v4/oa/access_token')) return handlers.oauth(url, i);
    throw new Error(`unexpected fetch ${url}`);
  });
  logLines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((msg: unknown) => {
      logLines.push(String(msg));
    });
  }
});

afterEach(() => jest.restoreAllMocks());

describe('ORDER_CREATED → ZBS ORDER_CONFIRMATION (integration)', () => {
  it('TEST 01 + 09 + 10 + 22: one confirmation job, sent once with mapped order data; msg_id + quota saved', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    expect(order.toJSON()).not.toHaveProperty('pendingNotificationEvents');
    const saved = await OrderModel.findById(order._id).lean();
    expect(saved?.pendingNotificationEvents).toEqual(['ORDER_CREATED', ZBS_ORDER_OUTBOX_MARKER]);

    await runBoth(svc);

    const jobs = await zbsJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: NotificationStatus.ACCEPTED,
      eventType: 'ORDER_CREATED',
      templateKey: 'ORDER_CONFIRMATION',
      templateId: TEMPLATE_ID,
      recipientId: NORMALIZED_PHONE,
      providerMessageId: 'zbs-msg-1',
      providerQuota: { dailyQuota: 500, remainingQuota: 499 },
      trackingId: `LGOC${order._id}`,
      attemptCount: 1,
    });
    expect(jobs[0].acceptedAt).toBeDefined();
    expect(jobs[0].deliveredAt).toBeUndefined(); // accepted ≠ delivered

    expect(sentBodies()).toEqual([
      {
        phone: NORMALIZED_PHONE,
        template_id: TEMPLATE_ID,
        template_data: {
          customer_name: 'Nguyễn Văn A',
          order_code: `#${order._id.toString().slice(-8).toUpperCase()}`,
          order_total: '259.000đ',
          order_status: 'Đã tiếp nhận',
        },
        tracking_id: `LGOC${order._id}`,
      },
    ]);
    expect((sendCalls()[0][1] as RequestInit).headers).toMatchObject({ access_token: SEED_ACCESS });
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual([]);
  });

  it('TEST 02 + 27: Zalo Bot behaviour and history unchanged next to ZBS', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await runBoth(svc);
    const bots = await botJobs();
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ status: NotificationStatus.ACCEPTED, recipientId: OWNER, providerMessageId: 'bot-msg-1' });
    expect(botCalls()).toHaveLength(1);
    // Bot admin views only see Bot rows; ZBS admin views only ZBS rows.
    const botList = await svc.notifications.listJobs({ page: 1, limit: 20 });
    expect(botList.total).toBe(1);
    expect(botList.data[0].channel).toBe('ZALO_BOT');
    expect(await svc.notifications.statusCounts()).toEqual({ ACCEPTED: 1 });
    const zbsList = await svc.zbs.listJobs({ page: 1, limit: 20 });
    expect(zbsList.total).toBe(1);
    expect(zbsList.data[0]).toMatchObject({ channel: ZALO_ZBS_CHANNEL, recipient: '849******89' });
    // A ZBS row can't be retried through the Bot endpoint (and vice versa).
    const zbsRow = (await zbsJobs())[0];
    await expect(svc.notifications.retryJob(zbsRow._id.toString(), 'staff')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.zbs.retryJob(bots[0]._id.toString(), 'staff')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TEST 03: ZBS disabled → no marker, no ZBS job, no ZBS request; Bot still works', async () => {
    env.ZALO_ZBS_ENABLED = 'false';
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual(['ORDER_CREATED']);
    await runBoth(svc);
    expect(await zbsJobs()).toHaveLength(0);
    expect(zbsAnyCalls()).toHaveLength(0);
    expect((await botJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
  });

  it('both channels disabled → checkout identical to before (no outbox field at all)', async () => {
    env.ZALO_ZBS_ENABLED = 'false';
    env.ZALO_BOT_ENABLED = 'false';
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toBeUndefined();
  });

  it('orders created while ZBS was disabled are never back-filled after enabling', async () => {
    env.ZALO_ZBS_ENABLED = 'false';
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await runBoth(svc);
    env.ZALO_ZBS_ENABLED = 'true';
    await runBoth(svc);
    expect(await zbsJobs()).toHaveLength(0);
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 04: credentials missing → SKIPPED_NOT_CONFIGURED, no ZBS request, checkout + Bot fine', async () => {
    env.ZALO_ZBS_APP_SECRET = '';
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    expect(order._id).toBeDefined();
    await runBoth(svc);
    const [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'CONFIG_INVALID', errorClass: 'CONFIGURATION_REQUIRED' });
    expect(job.lastErrorMessage).toContain('ZALO_ZBS_APP_SECRET');
    expect(zbsAnyCalls()).toHaveLength(0);
    expect((await botJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
  });

  it('TEST 05: template ID missing → SKIPPED_NOT_CONFIGURED, no send', async () => {
    env.ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION = '';
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await runBoth(svc);
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'CONFIG_INVALID' });
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 06: "+84 912 345 689" style input is normalized to 84xxxxxxxxx', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto('+84 912 345 689'));
    await svc.zbs.runOnce();
    expect(sentBodies()[0].phone).toBe(NORMALIZED_PHONE);
  });

  it('TEST 07: invalid phone → SKIPPED_INVALID_RECIPIENT, ZBS never called, Bot unaffected', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto('0287654321')); // landline — not a mobile number
    await runBoth(svc);
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_INVALID_RECIPIENT, lastErrorCode: 'PHONE_UNSUPPORTED_PREFIX', recipientId: '__invalid_phone__' });
    expect(zbsAnyCalls()).toHaveLength(0);
    expect((await botJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
  });

  it('TEST 08: missing phone → skipped, never sent to anyone else', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    await OrderModel.collection.updateOne({ _id: order._id }, { $set: { 'shippingInfo.phone': '' } });
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_INVALID_RECIPIENT, lastErrorCode: 'PHONE_MISSING' });
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 11: HTTP 200 + business error → not ACCEPTED (ineligible / data error)', async () => {
    handlers.send = () => zbsError(-118, 'Zalo account not existed');
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_INELIGIBLE, lastErrorCode: 'ZBS_-118', errorClass: 'NON_RETRYABLE' });

    handlers.send = () => zbsError(-1122, 'template data is missing a parameter');
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const failed = (await zbsJobs()).find((j) => j.lastErrorCode === 'ZBS_-1122');
    expect(failed?.status).toBe(NotificationStatus.FAILED);
    await svc.zbs.runOnce();
    expect(sendCalls()).toHaveLength(2); // no automatic retry of either
  });

  it('TEST 12: access token expired (-124) → refresh (rotation persisted) → ONE resend → ACCEPTED', async () => {
    let n = 0;
    handlers.send = () => (++n === 1 ? zbsError(-124, 'Access token invalid') : zbsOk('zbs-msg-after-refresh'));
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.ACCEPTED, providerMessageId: 'zbs-msg-after-refresh', attemptCount: 1 });
    expect(sendCalls().map((c) => ((c[1] as RequestInit).headers as Record<string, string>).access_token)).toEqual([SEED_ACCESS, 'zbs-access-rotated-1']);
    expect(calls('https://oauth-mock.test')).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(String((calls('https://oauth-mock.test')[0][1] as RequestInit).body))).refresh_token).toBe(SEED_REFRESH);
  });

  it('TEST 14: refresh token revoked → FAILED AUTHENTICATION_REQUIRED, no further sends, Bot unaffected', async () => {
    handlers.send = () => zbsError(-124, 'Access token invalid');
    handlers.oauth = () => json({ error: -14014, error_name: 'Invalid refresh token' }, 400);
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await runBoth(svc);
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.FAILED, errorClass: 'AUTHENTICATION_REQUIRED' });
    expect(sendCalls()).toHaveLength(1);
    expect((await svc.auth.statusView()).status).toBe('REAUTH_REQUIRED');
    // Next order: no OAuth call, no send — stopped before spending anything.
    fetchMock.mockClear();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect(sendCalls()).toHaveLength(0);
    expect(calls('https://oauth-mock.test')).toHaveLength(0);
    expect((await botJobs()).every((j) => j.status === NotificationStatus.ACCEPTED)).toBe(true);
  });

  it('TEST 15a: template not ENABLE (PENDING_REVIEW) → no send, SKIPPED_NOT_CONFIGURED with reason', async () => {
    handlers.info = () => templateInfo('PENDING_REVIEW');
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'TEMPLATE_NOT_ENABLED' });
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 15b: Zalo answers -131 at send → FAILED, template paused, next order not sent', async () => {
    handlers.send = () => zbsError(-131, 'Template not approved');
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.FAILED, errorClass: 'CONFIGURATION_REQUIRED', lastErrorCode: 'ZBS_-131' });
    expect((await TplModel.findOne().lean())?.status).toBe('SEND_REJECTED_-131');
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect(sendCalls()).toHaveLength(1);
    expect((await zbsJobs()).filter((j) => j.lastErrorCode === 'TEMPLATE_NOT_ENABLED')).toHaveLength(1);
  });

  it('template params mismatch with mapping → not sent', async () => {
    handlers.info = () => templateInfo('ENABLE', [...TEMPLATE_PARAMS, { name: 'payment_link', require: true, type: 'STRING', maxLength: 30, minLength: 0, acceptNull: false }]);
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'TEMPLATE_PARAMS_MISMATCH' });
    expect(job.lastErrorMessage).toContain('payment_link');
  });

  it('template-info not permitted → TEMPLATE_NOT_VERIFIED unless manually attested', async () => {
    handlers.info = () => zbsError(-138, 'App does not have permission');
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_NOT_CONFIGURED, lastErrorCode: 'TEMPLATE_NOT_VERIFIED' });
    env.ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED = TEMPLATE_ID;
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect(sendCalls()).toHaveLength(1);
  });

  it('template check fails transiently (network) → RETRY_PENDING (nothing sent), then sends once Zalo is reachable', async () => {
    let infoCalls = 0;
    handlers.info = () => (++infoCalls === 1 ? new Response('', { status: 503 }) : templateInfo());
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    let [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.RETRY_PENDING, lastErrorCode: 'TEMPLATE_NOT_VERIFIED', errorClass: 'RETRYABLE' });
    expect(sendCalls()).toHaveLength(0);
    await JobModel.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await svc.zbs.runOnce();
    [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.ACCEPTED, attemptCount: 2 });
    expect(sendCalls()).toHaveLength(1);
  });

  it.each([
    [-115, 'TEST 16 (balance)'],
    [-144, 'TEST 16 (daily quota)'],
    [-135, 'TEST 17 (OA permission)'],
    [-138, 'TEST 17 (app permission)'],
  ])('provider error %i %s → FAILED CONFIGURATION_REQUIRED, no automatic retry', async (code) => {
    handlers.send = () => zbsError(code);
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    await JobModel.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.FAILED, errorClass: 'CONFIGURATION_REQUIRED', lastErrorCode: `ZBS_${code}` });
    expect(sendCalls()).toHaveLength(1);
  });

  it('retryable provider error (-100) → bounded exponential backoff, then success', async () => {
    let n = 0;
    handlers.send = () => (++n <= 2 ? zbsError(-100, 'Unknown error') : zbsOk());
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    let [job] = await zbsJobs();
    expect(job.status).toBe(NotificationStatus.RETRY_PENDING);
    const firstDelay = new Date(job.nextAttemptAt).getTime() - Date.now();
    expect(firstDelay).toBeGreaterThan(55_000);
    await svc.zbs.runOnce(); // not due → nothing sent
    expect(sendCalls()).toHaveLength(1);
    await JobModel.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await svc.zbs.runOnce();
    [job] = await zbsJobs();
    expect(new Date(job.nextAttemptAt).getTime() - Date.now()).toBeGreaterThan(115_000); // 2× base
    await JobModel.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await svc.zbs.runOnce();
    [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.ACCEPTED, attemptCount: 3 });
  });

  it('retryable errors stop after maxRetries+1 attempts → FAILED', async () => {
    handlers.send = () => new Response('busy', { status: 503 });
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    for (let i = 0; i < 5; i++) {
      await svc.zbs.runOnce();
      await JobModel.updateMany({ status: NotificationStatus.RETRY_PENDING }, { $set: { nextAttemptAt: new Date(0) } });
    }
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.FAILED, attemptCount: 3 });
    expect(sendCalls()).toHaveLength(3);
  });

  it('night-time rejection (-133) → deferred to 07:05 Vietnam time', async () => {
    handlers.send = () => zbsError(-133, 'Not allow to send message at night');
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const [job] = await zbsJobs();
    expect(job.status).toBe(NotificationStatus.RETRY_PENDING);
    const vn = new Date(new Date(job.nextAttemptAt).getTime() + 7 * 3600_000);
    const sameDayDaytime = vn.getUTCHours() >= 7 && vn.getUTCHours() < 22;
    expect(sameDayDaytime).toBe(true);
  });

  it('TEST 18 + 26: network timeout → checkout returns immediately; outcome UNKNOWN; Bot unaffected', async () => {
    handlers.send = hang;
    const svc = build(); // real kick(): both workers run in the background
    const started = Date.now();
    const order = await svc.orders.create(userId, dto());
    expect(Date.now() - started).toBeLessThan(800);
    expect(order._id).toBeDefined();
    await runBoth(svc); // joins the in-flight background passes
    await new Promise((r) => setTimeout(r, 50));
    await runBoth(svc);
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.UNKNOWN, errorClass: 'UNKNOWN_OUTCOME', lastErrorCode: 'TIMEOUT' });
    expect((await botJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
  });

  it('TEST 25: ZBS API down (500s / thrown) never affects the Bot job', async () => {
    handlers.send = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    handlers.info = () => new Response('', { status: 500 });
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await runBoth(svc);
    expect((await botJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
    expect((await zbsJobs())[0].status).not.toBe(NotificationStatus.ACCEPTED);
  });

  it('TEST 19: duplicate ORDER_CREATED (marker re-delivered) → still one job, one paid send', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    await OrderModel.updateOne({ _id: order._id }, { $push: { pendingNotificationEvents: ZBS_ORDER_OUTBOX_MARKER } });
    await svc.zbs.runOnce();
    await svc.zbs.fanOutOrder((await OrderModel.findById(order._id))!);
    await svc.zbs.runOnce();
    expect(await zbsJobs()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(1);
  });

  it('TEST 20: concurrent workers / instances → exactly one send per order', async () => {
    const creator = buildQuiet();
    for (let i = 0; i < 3; i++) await creator.orders.create(userId, dto());
    const workers = [buildQuiet(), buildQuiet(), buildQuiet(), buildQuiet()];
    await Promise.all(workers.map((w) => w.zbs.runOnce()));
    await Promise.all(workers.map((w) => w.zbs.runOnce()));
    expect(await zbsJobs()).toHaveLength(3);
    expect(sendCalls()).toHaveLength(3);
    expect(new Set(sentBodies().map((b) => b.tracking_id)).size).toBe(3);
  });

  it('TEST 21: UNKNOWN outcome is never auto-resent; manual retry needs explicit confirmation', async () => {
    handlers.send = hang;
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    let [job] = await zbsJobs();
    expect(job.status).toBe(NotificationStatus.UNKNOWN);
    await JobModel.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await svc.zbs.runOnce();
    expect(sendCalls()).toHaveLength(1);

    await expect(svc.zbs.retryJob(job._id.toString(), 'staff-1')).rejects.toBeInstanceOf(BadRequestException);
    handlers.send = () => zbsOk('zbs-msg-manual');
    await svc.zbs.retryJob(job._id.toString(), 'staff-1', true);
    await svc.zbs.runOnce();
    [job] = await zbsJobs();
    expect(job).toMatchObject({ status: NotificationStatus.ACCEPTED, providerMessageId: 'zbs-msg-manual' });
    expect(sentBodies().map((b) => b.tracking_id)).toEqual([job.trackingId, job.trackingId]); // same notification id
    expect(svc.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ZALO_ZBS_NOTIFICATION_RETRY' }));
    // Already accepted (paid) → can never be retried again.
    await expect(svc.zbs.retryJob(job._id.toString(), 'staff-1', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('worker died mid-send (expired lease) → UNKNOWN, not resent', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.fanOutPendingOrders();
    await JobModel.updateMany(
      { channel: ZALO_ZBS_CHANNEL },
      { $set: { status: NotificationStatus.PROCESSING, lockOwner: 'dead-worker', lockedUntil: new Date(Date.now() - 1000) } },
    );
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.UNKNOWN, lastErrorCode: 'WORKER_LEASE_EXPIRED' });
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 23: payment pending → paymentStatus param says "Chưa thanh toán"', async () => {
    env.ZALO_ZBS_ORDER_CONFIRMATION_PARAMS = JSON.stringify({ ...PARAMS, payment_status: 'paymentStatus' });
    handlers.info = () => templateInfo('ENABLE', [...TEMPLATE_PARAMS, { name: 'payment_status', require: true, type: 'STRING', maxLength: 60, minLength: 0, acceptNull: false }]);
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    expect(sentBodies()[0].template_data).toMatchObject({ order_status: 'Đã tiếp nhận', payment_status: 'Chưa thanh toán' });
  });

  it('order cancelled before the send → SKIPPED_INELIGIBLE, no "received" message', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    await svc.zbs.fanOutPendingOrders();
    await OrderModel.updateOne({ _id: order._id }, { $set: { status: OrderStatus.CANCELLED } });
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.SKIPPED_INELIGIBLE, lastErrorCode: 'ORDER_CANCELLED' });
    expect(sendCalls()).toHaveLength(0);
  });

  it('TEST 24: status changes (shipped / delivered / cancelled) create no customer notification', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto());
    await runBoth(svc);
    const before = fetchMock.mock.calls.length;
    for (const status of [OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.DELIVERED]) {
      await svc.orders.updateStatus(order._id.toString(), { status } as UpdateOrderStatusDto, 'staff-1', StaffRole.ADMIN);
      await runBoth(svc);
    }
    const other = await svc.orders.create(userId, dto());
    await runBoth(svc);
    await svc.orders.updateStatus(other._id.toString(), { status: OrderStatus.CANCELLED } as UpdateOrderStatusDto, 'staff-1', StaffRole.ADMIN);
    await runBoth(svc);
    const jobs = await zbsJobs();
    expect(jobs).toHaveLength(2); // exactly one per order, both from ORDER_CREATED
    expect(jobs.every((j) => j.eventType === 'ORDER_CREATED' && j.templateKey === 'ORDER_CONFIRMATION')).toBe(true);
    expect(sendCalls()).toHaveLength(2);
    // Only the 2nd order's own ORDER_CREATED traffic: 1 ZBS send + 1 Bot message (template
    // info is cached) — none of the 4 status changes produced any request.
    expect(fetchMock.mock.calls.length - before).toBe(2);
  });

  it('local daily send limit → FAILED LOCAL_DAILY_LIMIT_REACHED without calling Zalo', async () => {
    env.ZALO_ZBS_DAILY_SEND_LIMIT = '1';
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const statuses = (await zbsJobs()).map((j) => j.lastErrorCode ?? j.status).sort();
    expect(statuses).toEqual(['ACCEPTED', 'LOCAL_DAILY_LIMIT_REACHED'].sort());
    expect(sendCalls()).toHaveLength(1);
  });

  it('manual retry after fixing the phone re-reads the order and sends once', async () => {
    const svc = buildQuiet();
    const order = await svc.orders.create(userId, dto('0287654321'));
    await svc.zbs.runOnce();
    const [job] = await zbsJobs();
    await expect(svc.zbs.retryJob(job._id.toString(), 'staff-1')).rejects.toThrow(/Số điện thoại/);
    await OrderModel.updateOne({ _id: order._id }, { $set: { 'shippingInfo.phone': '0987654321' } });
    await svc.zbs.retryJob(job._id.toString(), 'staff-1');
    await svc.zbs.runOnce();
    expect((await zbsJobs())[0]).toMatchObject({ status: NotificationStatus.ACCEPTED, recipientId: '84987654321' });
    expect(sendCalls()).toHaveLength(1);
  });

  it('delivery check: only provider status 1 marks DELIVERED', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const [job] = await zbsJobs();
    handlers.status = () => json({ error: 0, data: { status: 0, message: 'not delivered yet' } });
    expect(await svc.zbs.checkDelivery(job._id.toString(), 'staff-1')).toMatchObject({ ok: true, providerStatus: 0 });
    expect((await zbsJobs())[0].status).toBe(NotificationStatus.ACCEPTED);
    handlers.status = () => json({ error: 0, data: { status: 1, delivery_time: '1760760100000' } });
    expect(await svc.zbs.checkDelivery(job._id.toString(), 'staff-1')).toMatchObject({ ok: true, providerStatus: 1 });
    const after = (await zbsJobs())[0];
    expect(after.status).toBe(NotificationStatus.DELIVERED);
    expect(new Date(after.deliveredAt!).getTime()).toBe(1760760100000);
    const statusUrl = String(calls('https://zbs-mock.test/message/status')[0][0]);
    expect(statusUrl).toContain('message_id=zbs-msg-1');
  });

  it('stats: accepted counts, last quota, labelled cost estimate from template price', async () => {
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.zbs.runOnce();
    const stats = await svc.zbs.stats();
    expect(stats).toMatchObject({
      acceptedToday: 1,
      acceptedThisMonth: 1,
      lastQuota: { dailyQuota: 500, remainingQuota: 499 },
      costEstimate: { unitPriceVnd: 300, unitPriceSource: 'TEMPLATE_INFO', acceptedThisMonthVnd: 300 },
    });
  });

  it('TEST 28: logs and admin views never contain full phone numbers or tokens', async () => {
    let n = 0;
    handlers.send = () => (++n === 1 ? zbsError(-124) : zbsOk());
    const svc = buildQuiet();
    await svc.orders.create(userId, dto());
    await svc.orders.create(userId, dto('0287654321'));
    await runBoth(svc);
    const status = JSON.stringify({ list: await svc.zbs.listJobs({ page: 1, limit: 20 }), cred: await svc.auth.statusView(), tpl: await svc.zbs.templateView() });
    const haystack = `${logLines.join('\n')}\n${status}`;
    for (const secret of [NORMALIZED_PHONE, CHECKOUT_PHONE, '0287654321', SEED_ACCESS, SEED_REFRESH, APP_SECRET, 'zbs-access-rotated-1', 'zbs-refresh-rotated-1']) {
      expect(haystack).not.toContain(secret);
    }
    expect(logLines.some((l) => l.includes('849******89'))).toBe(true);
    // Tokens at rest are encrypted.
    const cred = JSON.stringify(await CredModel.findOne().lean());
    expect(cred).not.toContain('zbs-refresh-rotated-1');
  });
});
