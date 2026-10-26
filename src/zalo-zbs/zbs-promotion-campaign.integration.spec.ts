import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema } from '../orders/schemas/order.schema';
import { Promotion, PromotionDocument, PromotionSchema } from '../promotions/schemas/promotion.schema';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { ZbsCredential, ZbsCredentialDocument, ZbsCredentialSchema } from './schemas/zbs-credential.schema';
import {
  ZbsTemplateVerification,
  ZbsTemplateVerificationDocument,
  ZbsTemplateVerificationSchema,
} from './schemas/zbs-template-verification.schema';
import { ZbsCampaign, ZbsCampaignAudience, ZbsCampaignDocument, ZbsCampaignSchema, ZbsCampaignStatus } from './schemas/zbs-campaign.schema';
import {
  ZbsCampaignMessage,
  ZbsCampaignMessageDocument,
  ZbsCampaignMessageSchema,
  ZbsCampaignMessageStatus as S,
} from './schemas/zbs-campaign-message.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { ZbsTemplateService } from './zbs-template.service';
import { inVnSendWindow, nextVnWindowStart, tomorrowVnWindowStart, ZbsPromotionCampaignService } from './zbs-promotion-campaign.service';

/**
 * Promotion campaigns end-to-end over a real (in-memory) MongoDB with mocked Zalo HTTP:
 * draft (audience, exclusions, dedup) → confirm → worker → persisted outcomes, pause/resume/
 * cancel. Only Date is faked (10:00 Vietnam time) so the send window is deterministic.
 */
jest.setTimeout(90_000);

const TEMPLATE_ID = '652780';
const PARAMS = {
  customer_name: 'customerName',
  coupon_code: 'couponCode',
  coupon_value: 'couponValue',
  min_order_value: 'minOrderValue',
  start_date: 'startDate',
  end_date: 'endDate',
};
const TEMPLATE_PARAMS = Object.keys(PARAMS).map((name) => ({ name, require: true, type: 'STRING', maxLength: 30, minLength: 0, acceptNull: false }));
const NOW = new Date('2026-10-26T03:00:00Z'); // 10:00 VN
const STAFF = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let PromoModel: Model<PromotionDocument>;
let UserModel: Model<UserDocument>;
let CredModel: Model<ZbsCredentialDocument>;
let TplModel: Model<ZbsTemplateVerificationDocument>;
let CampaignModel: Model<ZbsCampaignDocument>;
let MsgModel: Model<ZbsCampaignMessageDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let handlers: { send: Handler; info: Handler; status: Handler };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const zbsOk = (msgId = 'promo-msg') => json({ error: 0, message: 'Success', data: { msg_id: msgId, sent_time: '1761447600000', quota: { dailyQuota: '500', remainingQuota: '400' } } });
const zbsError = (code: number) => json({ error: code, message: 'error' });
const templateInfo = (status = 'ENABLE') =>
  json({ error: 0, message: 'Success', data: { templateId: TEMPLATE_ID, templateName: 'Chương trình khuyến mãi', status, listParams: TEMPLATE_PARAMS, templateTag: 'PROMOTION', price_sdt: '450' } });
function hang(_url: string, init: RequestInit) {
  return new Promise<Response>((_r, reject) =>
    init.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    }),
  );
}
const sendCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://zbs-mock.test/message/template'));
const sentBodies = () => sendCalls().map((c) => JSON.parse((c[1] as RequestInit).body as string));

function build() {
  const configService = { get: (k: string) => env[k] } as unknown as ConfigService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const cfg = new ZaloZbsConfigService(configService);
  const client = new ZbsApiClient(cfg);
  const auth = new ZbsAuthService(CredModel, cfg, client);
  const templates = new ZbsTemplateService(TplModel, client, auth);
  const svc = new ZbsPromotionCampaignService(CampaignModel, MsgModel, PromoModel, UserModel, OrderModel, cfg, client, auth, templates, audit);
  jest.spyOn(svc, 'kick').mockImplementation(() => undefined);
  return { svc, audit };
}

// ── Fixtures ──
let promoId: Types.ObjectId;
let couponId: Types.ObjectId;
const users: Record<string, Types.ObjectId> = {};

async function addUser(key: string, fields: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  users[key] = _id;
  await UserModel.collection.insertOne({ _id, email: `${key}@test.vn`, name: `Khách ${key}`, isDeleted: false, isBlocked: false, isGuest: false, ...fields });
  return _id;
}
async function addOrder(userKey: string, status: string, phone: string, extra: Record<string, unknown> = {}) {
  await OrderModel.collection.insertOne({
    userId: users[userKey],
    status,
    shippingInfo: { recipientName: 'X', phone },
    isDeleted: false,
    createdAt: new Date(NOW.getTime() - Math.random() * 1e8),
    ...extra,
  });
}
async function seedPromotion(over: Record<string, unknown> = {}, couponOver: Record<string, unknown> = {}) {
  couponId = new Types.ObjectId();
  const p = await PromoModel.create({
    name: 'Tri ân khách hàng',
    startDate: new Date('2026-10-17T17:00:00Z'),
    endDate: new Date('2026-11-17T16:59:59Z'),
    isActive: true,
    assignedToAll: true,
    coupons: [
      { _id: couponId, code: 'TRIAN20', type: 'percentage', value: 20, minOrderValue: 50000, maxDiscountAmount: 100000, totalUsageLimit: 0, perUserUsageLimit: 1, ...couponOver },
    ],
    ...over,
  });
  promoId = p._id;
}

/** a, b: delivered customers; c: only a pending order; d: blocked; e: no phone anywhere;
 * f: same phone as a; g: Shopee-only (masked); h: invalid phone. */
async function seedCustomers() {
  await addUser('a');
  await addOrder('a', 'DELIVERED', '0912345601');
  await addUser('b', { phone: '0912345699' });
  await addOrder('b', 'DELIVERED', '0912345602'); // order phone wins over account phone
  await addUser('c');
  await addOrder('c', 'PENDING', '0912345603');
  await addUser('d', { isBlocked: true });
  await addOrder('d', 'DELIVERED', '0912345604');
  await addUser('e');
  await addOrder('e', 'DELIVERED', '');
  await addUser('f');
  await addOrder('f', 'DELIVERED', '+84 912 345 601');
  await addUser('g');
  await addOrder('g', 'DELIVERED', '(+84)******123', { externalRef: { channel: 'SHOPEE', code: 'S1' } });
  await addUser('h');
  await addOrder('h', 'DELIVERED', '0212345678');
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri(), { autoIndex: false }).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  PromoModel = conn.model(Promotion.name, PromotionSchema) as unknown as Model<PromotionDocument>;
  UserModel = conn.model(User.name, UserSchema) as unknown as Model<UserDocument>;
  CredModel = conn.model(ZbsCredential.name, ZbsCredentialSchema) as unknown as Model<ZbsCredentialDocument>;
  TplModel = conn.model(ZbsTemplateVerification.name, ZbsTemplateVerificationSchema) as unknown as Model<ZbsTemplateVerificationDocument>;
  CampaignModel = conn.model(ZbsCampaign.name, ZbsCampaignSchema) as unknown as Model<ZbsCampaignDocument>;
  MsgModel = conn.model(ZbsCampaignMessage.name, ZbsCampaignMessageSchema) as unknown as Model<ZbsCampaignMessageDocument>;
  await Promise.all([CredModel.createIndexes(), TplModel.createIndexes(), CampaignModel.createIndexes(), MsgModel.createIndexes()]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  await Promise.all(([OrderModel, PromoModel, UserModel, CredModel, TplModel, CampaignModel, MsgModel] as unknown as Model<unknown>[]).map((m) => m.deleteMany({})));
  env = {
    ZALO_ZBS_ENABLED: 'false', // order confirmations stay off — campaigns are independent
    ZALO_ZBS_PROMOTION_ENABLED: 'true',
    ZALO_ZBS_APP_ID: '1234567890',
    ZALO_ZBS_APP_SECRET: 'zbs-app-secret-0001',
    ZALO_ZBS_ACCESS_TOKEN: 'zbs-seed-access-token-0001',
    ZALO_ZBS_REFRESH_TOKEN: 'zbs-seed-refresh-token-0001',
    ZALO_ZBS_TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
    ZALO_ZBS_TEMPLATE_PROMOTION: TEMPLATE_ID,
    ZALO_ZBS_PROMOTION_PARAMS: JSON.stringify(PARAMS),
    ZALO_ZBS_API_BASE_URL: 'https://zbs-mock.test',
    ZALO_ZBS_OAUTH_BASE_URL: 'https://oauth-mock.test',
    ZALO_ZBS_REQUEST_TIMEOUT_MS: '1000',
    ZALO_ZBS_RETRY_BASE_DELAY_MS: '60000',
    ZALO_ZBS_MAX_RETRIES: '2',
  };
  let n = 0;
  handlers = {
    send: () => zbsOk(`promo-msg-${++n}`),
    info: () => templateInfo(),
    status: () => json({ error: 0, message: 'Success', data: { status: 1, delivery_time: '1761447700000' } }),
  };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const i = init as RequestInit;
    if (url.startsWith('https://zbs-mock.test/message/template')) return handlers.send(url, i);
    if (url.startsWith('https://zbs-mock.test/template/info/v2')) return handlers.info(url, i);
    if (url.startsWith('https://zbs-mock.test/message/status')) return handlers.status(url, i);
    throw new Error(`unexpected fetch ${url}`);
  });
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  await seedPromotion();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function markCouponUsedBy(userKey: string) {
  await PromoModel.updateOne({ _id: promoId, 'coupons._id': couponId }, { $push: { 'coupons.$.usageRecords': { userId: users[userKey], count: 1 } } });
}

const draft = (svc: ZbsPromotionCampaignService, audience = ZbsCampaignAudience.DELIVERED_CUSTOMERS) =>
  svc.createDraft({ promotionId: promoId.toString(), couponId: couponId.toString(), audience }, STAFF);

async function drain(svc: ZbsPromotionCampaignService) {
  for (let i = 0; i < 10; i++) {
    const r = await svc.runOnce();
    if (!r.processed) return;
  }
}

describe('helpers', () => {
  it('send window and next window start use Vietnam time', () => {
    expect(inVnSendWindow(new Date('2026-10-26T01:00:00Z'), 8, 21)).toBe(true); // 08:00
    expect(inVnSendWindow(new Date('2026-10-26T00:59:00Z'), 8, 21)).toBe(false); // 07:59
    expect(inVnSendWindow(new Date('2026-10-26T14:00:00Z'), 8, 21)).toBe(false); // 21:00
    expect(nextVnWindowStart(new Date('2026-10-26T00:00:00Z'), 8).toISOString()).toBe('2026-10-26T01:00:00.000Z');
    expect(nextVnWindowStart(new Date('2026-10-26T14:30:00Z'), 8).toISOString()).toBe('2026-10-27T01:00:00.000Z');
    // 21:30 VN: tomorrow is the next calendar day, not the day after.
    expect(tomorrowVnWindowStart(new Date('2026-10-26T14:30:00Z'), 8).toISOString()).toBe('2026-10-27T01:00:00.000Z');
    expect(tomorrowVnWindowStart(new Date('2026-10-25T17:30:00Z'), 8).toISOString()).toBe('2026-10-27T01:00:00.000Z'); // 00:30 VN 26th
  });
});

describe('draft', () => {
  it('builds the audience with exclusions, dedups phones and previews the 652780 params', async () => {
    await seedCustomers();
    await addUser('i');
    await addOrder('i', 'DELIVERED', '0912345609');
    await markCouponUsedBy('i');
    const { svc } = build();
    const res = await draft(svc);
    expect(res.campaign.status).toBe(ZbsCampaignStatus.DRAFT);
    expect(res.campaign.recipientCount).toBe(2); // a (f has the same phone), b
    expect(res.campaign.exclusions).toMatchObject({
      blockedOrDeleted: 1, // d
      noPhone: 1, // e
      duplicatePhone: 1, // f
      invalidPhone: 1, // h ; g's Shopee order is ignored entirely
      couponAlreadyUsed: 1, // i
      notAllowedByPromotion: 0,
      alreadyReceived: 0,
    });
    expect(res.preview.templateData).toEqual({
      customer_name: 'Khách a',
      coupon_code: 'TRIAN20',
      coupon_value: '20%',
      min_order_value: '50.000đ',
      start_date: '18/10/2026',
      end_date: '17/11/2026',
    });
    expect(res.preview.samplePhone).not.toContain('345601');
    expect(res.campaign.costEstimate).toMatchObject({ unitPriceVnd: 450, maxVnd: 900 });
    const msgs = await MsgModel.find().sort({ _id: 1 }).lean();
    expect(msgs.map((m) => m.phone).sort()).toEqual(['84912345601', '84912345602']);
    expect(msgs.every((m) => m.status === S.DRAFT && /^LGPR[0-9a-f]{24}$/.test(m.trackingId))).toBe(true);
    expect(sendCalls()).toHaveLength(0); // a draft never sends
  });

  it('ORDERED_CUSTOMERS includes pending-order customers; non-assigned users are excluded when not assignedToAll', async () => {
    await seedCustomers();
    const { svc } = build();
    expect((await draft(svc, ZbsCampaignAudience.ORDERED_CUSTOMERS)).campaign.recipientCount).toBe(3); // a, b, c
    await CampaignModel.deleteMany({});
    await MsgModel.deleteMany({});
    await PromoModel.updateOne({ _id: promoId }, { $set: { assignedToAll: false, assignedUsers: [users.b] } });
    const res = await draft(svc);
    expect(res.campaign.recipientCount).toBe(1);
    expect(res.campaign.exclusions.notAllowedByPromotion).toBeGreaterThan(0);
  });

  it('ASSIGNED_USERS falls back to the account phone', async () => {
    await addUser('z', { phone: '0987654321' });
    await PromoModel.updateOne({ _id: promoId }, { $set: { assignedToAll: false, assignedUsers: [users.z] } });
    const { svc } = build();
    await draft(svc, ZbsCampaignAudience.ASSIGNED_USERS);
    expect((await MsgModel.findOne().lean())!.phone).toBe('84987654321');
  });

  it('refuses: second open campaign for a coupon, unavailable coupon, unready template, too many recipients, no recipients', async () => {
    await seedCustomers();
    const { svc } = build();
    await draft(svc);
    await expect(draft(svc)).rejects.toBeInstanceOf(ConflictException);
    await CampaignModel.deleteMany({});
    await MsgModel.deleteMany({});

    env.ZALO_ZBS_PROMOTION_MAX_RECIPIENTS = '1';
    await expect(draft(svc)).rejects.toThrow('vượt giới hạn 1');
    env.ZALO_ZBS_PROMOTION_MAX_RECIPIENTS = '500';

    await PromoModel.updateOne({ _id: promoId }, { $set: { 'coupons.0.totalUsageLimit': 5, 'coupons.0.totalUsedCount': 5 } });
    await expect(draft(svc)).rejects.toThrow('hết lượt');
    await PromoModel.updateOne({ _id: promoId }, { $set: { 'coupons.0.totalUsageLimit': 0, endDate: new Date('2026-10-01') } });
    await expect(draft(svc)).rejects.toThrow('đã kết thúc');
    await PromoModel.updateOne({ _id: promoId }, { $set: { endDate: new Date('2026-11-17T16:59:59Z') } });

    await TplModel.deleteMany({}); // the ENABLE result is cached for 6 h
    handlers.info = () => templateInfo('PENDING_REVIEW');
    await expect(draft(svc)).rejects.toThrow('PENDING_REVIEW');
    await TplModel.deleteMany({});
    handlers.info = () => templateInfo();

    await PromoModel.updateOne({ _id: promoId }, { $set: { assignedToAll: false, assignedUsers: [] } });
    await expect(draft(svc)).rejects.toBeInstanceOf(BadRequestException);
    expect(await CampaignModel.countDocuments()).toBe(0);
  });

  it('warns when the coupon has fewer uses left than recipients', async () => {
    await seedCustomers();
    await PromoModel.updateOne({ _id: promoId }, { $set: { 'coupons.0.totalUsageLimit': 1 } });
    const { svc } = build();
    const res = await draft(svc);
    expect(res.campaign.warnings.join(' ')).toContain('chỉ còn 1 lượt');
  });

  it('a draft can be prepared while ZALO_ZBS_PROMOTION_ENABLED=false, but not confirmed', async () => {
    await seedCustomers();
    env.ZALO_ZBS_PROMOTION_ENABLED = 'false';
    const { svc } = build();
    const res = await draft(svc);
    await expect(svc.confirm(res.campaign._id, 2, STAFF)).rejects.toThrow('ZALO_ZBS_PROMOTION_ENABLED=false');
  });
});

describe('confirm + worker', () => {
  it('sends exactly one message per recipient with the approved params, then completes', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await expect(svc.confirm(campaign._id, 3, STAFF)).rejects.toThrow('không khớp');
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    await drain(svc);

    const bodies = sentBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.phone).sort()).toEqual(['84912345601', '84912345602']);
    expect(bodies[0]).toMatchObject({ template_id: TEMPLATE_ID, template_data: { coupon_code: 'TRIAN20', coupon_value: '20%', end_date: '17/11/2026' } });
    expect(bodies[0].tracking_id).toMatch(/^LGPR[0-9a-f]{24}$/);
    expect(bodies[0].mode).toBeUndefined();
    const view = await svc.getCampaign(campaign._id);
    expect(view.status).toBe(ZbsCampaignStatus.COMPLETED);
    expect(view.counts).toEqual({ ACCEPTED: 2 });
    expect(view.costEstimate).toMatchObject({ acceptedVnd: 900 });

    // The same coupon never reaches these phones again.
    await expect(draft(svc)).rejects.toThrow('Không có người nhận hợp lệ');
  });

  it('sends nothing outside the VN send window', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    jest.setSystemTime(new Date('2026-10-26T15:00:00Z')); // 22:00 VN
    expect((await svc.runOnce()).processed).toBe(0);
    expect(sendCalls()).toHaveLength(0);
  });

  it('respects the local daily cap', async () => {
    await seedCustomers();
    env.ZALO_ZBS_PROMOTION_DAILY_SEND_LIMIT = '1';
    const { svc } = build();
    const { campaign } = await draft(svc);
    expect(campaign.warnings.join(' ')).toContain('nhiều ngày');
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    expect(sendCalls()).toHaveLength(1);
    expect((await svc.getCampaign(campaign._id)).status).toBe(ZbsCampaignStatus.SENDING);
  });

  it('ineligible recipient → SKIPPED; timeout → UNKNOWN and never resent', async () => {
    await seedCustomers();
    let n = 0;
    handlers.send = (url, init) => (++n === 1 ? zbsError(-118) : hang(url, init));
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    await drain(svc);
    const statuses = (await MsgModel.find().lean()).map((m) => m.status).sort();
    expect(statuses).toEqual([S.SKIPPED_INELIGIBLE, S.UNKNOWN]);
    expect(sendCalls()).toHaveLength(2);
    expect((await svc.getCampaign(campaign._id)).status).toBe(ZbsCampaignStatus.COMPLETED);
  });

  it('insufficient ZBS balance pauses the campaign without consuming the message; resume continues', async () => {
    await seedCustomers();
    handlers.send = () => zbsError(-115);
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    expect(sendCalls()).toHaveLength(1); // stopped after the first refusal
    let view = await svc.getCampaign(campaign._id);
    expect(view).toMatchObject({ status: ZbsCampaignStatus.PAUSED, pauseCode: 'ZBS_-115' });
    expect(view.counts).toEqual({ PENDING: 2 });
    expect((await MsgModel.find().lean()).every((m) => m.attemptCount === 0)).toBe(true);

    handlers.send = () => zbsOk();
    await svc.resume(campaign._id, STAFF);
    await drain(svc);
    await drain(svc);
    view = await svc.getCampaign(campaign._id);
    expect(view).toMatchObject({ status: ZbsCampaignStatus.COMPLETED, counts: { ACCEPTED: 2 } });
  });

  it("Zalo's daily quota (-144) defers everything to tomorrow's window", async () => {
    await seedCustomers();
    handlers.send = () => zbsError(-144);
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    expect(sendCalls()).toHaveLength(1);
    const msgs = await MsgModel.find().lean();
    expect(msgs.every((m) => m.status === S.PENDING && m.nextAttemptAt.toISOString() === '2026-10-27T01:00:00.000Z')).toBe(true);
    expect((await svc.getCampaign(campaign._id)).status).toBe(ZbsCampaignStatus.SENDING);
  });

  it('a coupon exhausted mid-campaign pauses it before sending', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await PromoModel.updateOne({ _id: promoId }, { $set: { 'coupons.0.totalUsageLimit': 3, 'coupons.0.totalUsedCount': 3 } });
    await drain(svc);
    expect(sendCalls()).toHaveLength(0);
    expect(await svc.getCampaign(campaign._id)).toMatchObject({ status: ZbsCampaignStatus.PAUSED, pauseCode: 'COUPON_EXHAUSTED' });
    await expect(svc.resume(campaign._id, STAFF)).rejects.toThrow('hết lượt');
  });

  it('a recipient who used the coupon after the draft is skipped', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await markCouponUsedBy('a');
    await drain(svc);
    await drain(svc);
    expect(sendCalls()).toHaveLength(1);
    expect((await MsgModel.findOne({ userId: users.a }).lean())!.lastErrorCode).toBe('COUPON_ALREADY_USED');
  });

  it('cancel drops unsent messages and releases their phones; sent ones stay excluded', async () => {
    await seedCustomers();
    env.ZALO_ZBS_PROMOTION_DAILY_SEND_LIMIT = '1';
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    await svc.cancel(campaign._id, STAFF);
    const view = await svc.getCampaign(campaign._id);
    expect(view).toMatchObject({ status: ZbsCampaignStatus.CANCELLED, counts: { ACCEPTED: 1, CANCELLED: 1 } });

    const next = await draft(svc);
    expect(next.campaign.recipientCount).toBe(1);
    expect(next.campaign.exclusions.alreadyReceived).toBe(1);
  });

  it('cancelling a DRAFT deletes its messages; an expired draft cannot be confirmed', async () => {
    await seedCustomers();
    const { svc } = build();
    const first = await draft(svc);
    await svc.cancel(first.campaign._id, STAFF);
    expect(await MsgModel.countDocuments({ campaignId: first.campaign._id })).toBe(0);
    const second = await draft(svc);
    jest.setSystemTime(new Date(NOW.getTime() + 25 * 3600 * 1000));
    await expect(svc.confirm(second.campaign._id, 2, STAFF)).rejects.toThrow('quá 24 giờ');
  });

  it('pause stops sending; a template that became unusable (-131) pauses and blocks resume until re-verified', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await svc.pause(campaign._id, STAFF);
    await drain(svc);
    expect(sendCalls()).toHaveLength(0);

    handlers.send = () => zbsError(-131);
    await svc.resume(campaign._id, STAFF);
    await drain(svc);
    expect(await svc.getCampaign(campaign._id)).toMatchObject({ status: ZbsCampaignStatus.PAUSED, pauseCode: 'ZBS_-131' });
    expect((await TplModel.findOne({ templateKey: 'PROMOTION' }).lean())!.status).toBe('SEND_REJECTED_-131');
    await expect(svc.resume(campaign._id, STAFF)).rejects.toThrow('SEND_REJECTED_-131');
  });

  it('check-delivery marks DELIVERED only on provider status 1', async () => {
    await seedCustomers();
    const { svc } = build();
    const { campaign } = await draft(svc);
    await svc.confirm(campaign._id, 2, STAFF);
    await drain(svc);
    const msg = (await MsgModel.findOne({ status: S.ACCEPTED }).lean())!;
    expect(await svc.checkDelivery(msg._id.toString(), STAFF)).toEqual({ ok: true, providerStatus: 1 });
    expect((await MsgModel.findById(msg._id).lean())!.status).toBe(S.DELIVERED);
  });
});
