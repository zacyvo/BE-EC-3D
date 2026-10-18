import { BadRequestException, ConflictException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order, OrderDocument, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto } from '../orders/dto/order.dto';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { Promotion, PromotionDocument, PromotionSchema } from '../promotions/schemas/promotion.schema';
import { PromotionsService } from '../promotions/promotions.service';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import { ZaloOaIdentityService } from './zalo-oa-identity.service';
import { ZaloOaRecipientService } from './zalo-oa-recipient.service';
import { ZaloOaCouponAssignmentService } from './zalo-oa-coupon-assignment.service';
import { ZaloOaRewardService } from './zalo-oa-reward.service';
import { ZaloOaWebhookService } from './zalo-oa-webhook.service';
import { computeOaWebhookMac } from './zalo-oa-crypto';
import { IneligibleReason, RecipientResolution, RewardPhoneSource, RewardSessionState } from './zalo-oa-reward.constants';
import { ZaloOaRewardSession, ZaloOaRewardSessionDocument, ZaloOaRewardSessionSchema } from './schemas/zalo-oa-reward-session.schema';
import { ZaloOaFollower, ZaloOaFollowerDocument, ZaloOaFollowerSchema } from './schemas/zalo-oa-follower.schema';
import { ZaloOaLink, ZaloOaLinkDocument, ZaloOaLinkSchema } from './schemas/zalo-oa-link.schema';
import { ZaloOaRewardGrant, ZaloOaRewardGrantDocument, ZaloOaRewardGrantSchema } from './schemas/zalo-oa-reward-grant.schema';
import { ZaloOaWebhookEvent, ZaloOaWebhookEventDocument, ZaloOaWebhookEventSchema } from './schemas/zalo-oa-webhook-event.schema';

/**
 * End-to-end over a real (in-memory) MongoDB with the REAL PromotionsService, UsersService and
 * OrdersService, and mocked Zalo HTTP (OAuth v4 + graph /me). Numbering = the prompt's test list.
 */
jest.setTimeout(90_000);

const PROMOTION_ID = '6ad48f1007c02f629c44496a';
const COUPON_ID = '6ad48f8007c02f629c4449a3';
const OA_ID = '388613280879808645';
const APP_ID = '36084652489903967';
const OA_SECRET = 'oa-secret-key-for-tests';
const BASE_ENV: Record<string, string> = {
  ZALO_OA_REWARD_ENABLED: 'true',
  ZALO_OA_ID: OA_ID,
  ZALO_OA_URL: `https://zalo.me/${OA_ID}`,
  ZALO_OA_APP_ID: APP_ID,
  ZALO_OA_APP_SECRET: 'app-secret-for-tests',
  ZALO_OA_WEBHOOK_SECRET: OA_SECRET,
  ZALO_OA_OAUTH_REDIRECT_URI: 'https://api.test/api/v1/zalo-oa-reward/oauth/callback',
  ZALO_OA_PROMOTION_ID: PROMOTION_ID,
  ZALO_OA_COUPON_ID: COUPON_ID,
  FRONTEND_URL: 'https://shop.test',
  ZALO_OA_OAUTH_BASE_URL: 'https://oauth-mock.test',
  ZALO_OA_GRAPH_BASE_URL: 'https://graph-mock.test',
  ZALO_OA_REQUEST_TIMEOUT_MS: '500',
  // Zalo Bot / ZBS values present on purpose: the OA module must ignore them.
  ZALO_BOT_WEBHOOK_SECRET: 'bot-secret',
  ZALO_ZBS_APP_SECRET: 'zbs-secret',
};

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let UserModel: Model<UserDocument>;
let PromoModel: Model<PromotionDocument>;
let SessionModel: Model<ZaloOaRewardSessionDocument>;
let FollowerModel: Model<ZaloOaFollowerDocument>;
let LinkModel: Model<ZaloOaLinkDocument>;
let GrantModel: Model<ZaloOaRewardGrantDocument>;
let EventModel: Model<ZaloOaWebhookEventDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
/** access tokens /me rejects (simulates a forged / foreign-app token). */
let rejectedTokens: Set<string>;

const productId = new Types.ObjectId();
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const flush = () => new Promise((r) => setTimeout(r, 30));

function build() {
  const configService = { get: (k: string) => env[k] } as unknown as ConfigService;
  const cfg = new ZaloOaRewardConfigService(configService);
  const promotions = new PromotionsService(PromoModel);
  const users = new UsersService(UserModel, {} as never, {} as never);
  const identity = new ZaloOaIdentityService(cfg);
  const recipients = new ZaloOaRecipientService(LinkModel, users);
  const coupons = new ZaloOaCouponAssignmentService(GrantModel, promotions, cfg);
  const rewards = new ZaloOaRewardService(SessionModel, FollowerModel, OrderModel, cfg, identity, recipients, coupons);
  const webhook = new ZaloOaWebhookService(FollowerModel, EventModel, cfg, rewards);
  // Track the post-follow correlation the webhook schedules, so tests await it deterministically.
  const pending: Promise<void>[] = [];
  const onFollowerUpdated = rewards.onFollowerUpdated.bind(rewards);
  rewards.onFollowerUpdated = (f) => {
    const p = onFollowerUpdated(f);
    pending.push(p);
    return p;
  };
  const products = {
    findById: jest.fn(async () => ({ _id: productId, name: 'Đèn ngủ 3D', slug: 'den-ngu-3d', stock: 99, finalPrice: 200000, colors: [], sizes: [], images: ['https://img/1.jpg'] })),
  };
  const orders = new OrdersService(
    OrderModel, VersionModel, products as never, { clearCart: jest.fn() } as never,
    { log: jest.fn() } as never, promotions, users, {} as never,
    { orderCreatedOutboxFields: () => ({}), kick: jest.fn() } as never,
  );
  return { rewards, webhook, recipients, coupons, promotions, users, orders, pending };
}

async function seedCampaign(overrides: Record<string, unknown> = {}, couponOverrides: Record<string, unknown> = {}) {
  await PromoModel.create({
    _id: new Types.ObjectId(PROMOTION_ID),
    name: 'ZALO_OA',
    description: 'Quan tâm ZALO_OA của Luxe Glow để nhận được mã giảm giá 20%',
    startDate: new Date(Date.now() - 86_400_000),
    endDate: new Date(Date.now() + 30 * 86_400_000),
    isActive: true,
    assignedToAll: false,
    assignedUsers: [],
    // Mirrors the production record verified on 2026-10-18 (incl. totalUsageLimit = 1).
    coupons: [{ _id: new Types.ObjectId(COUPON_ID), code: 'ZALO_OA', type: 'percentage', value: 20, minOrderValue: 50000, maxDiscountAmount: 1000000, totalUsageLimit: 1, perUserUsageLimit: 1, totalUsedCount: 0, usageRecords: [], ...couponOverrides }],
    ...overrides,
  });
}

let seq = 0;
async function createUser(phone?: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return UserModel.create({ email: `u${seq}@mail.test`, name: `User ${seq}`, password: '$2b$12$hash', ...(phone ? { phone } : {}), ...extra });
}
async function createOrder(userId: Types.ObjectId, extra: Record<string, unknown> = {}) {
  return OrderModel.create({
    userId,
    items: [{ productId, productName: 'Đèn', productImage: 'x', productSlug: 'den', quantity: 1, unitPrice: 200000, subtotal: 200000 }],
    shippingInfo: { recipientName: 'Khách', phone: '0912000111', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    subtotal: 200000,
    total: 200000,
    ...extra,
  });
}

/** Website → connect link → Zalo Login (mocked) → callback. Returns the redirect target. */
async function zaloLogin(svc: ReturnType<typeof build>, userId: string, orderId: string, appUserId: string) {
  const { connectUrl } = await svc.rewards.prepareLink(userId, orderId);
  const rs = new URL(connectUrl).searchParams.get('rs');
  const start = await svc.rewards.beginConnect(rs);
  const state = new URL(start.url).searchParams.get('state');
  return svc.rewards.handleOAuthCallback({ code: `code-${appUserId}`, state });
}

function signedFollow(opts: { userIdByApp: string; oaUid: string; event?: 'follow' | 'unfollow'; ts?: number; oaId?: string; appId?: string; secret?: string }) {
  const raw = JSON.stringify({
    oa_id: opts.oaId ?? OA_ID,
    follower: { id: opts.oaUid },
    user_id_by_app: opts.userIdByApp,
    event_name: opts.event ?? 'follow',
    source: 'oa_profile',
    app_id: opts.appId ?? APP_ID,
    timestamp: String(opts.ts ?? Date.now()),
  });
  const mac = computeOaWebhookMac(APP_ID, raw, String(opts.ts ?? JSON.parse(raw).timestamp), opts.secret ?? OA_SECRET);
  return { raw: Buffer.from(raw), mac };
}
async function deliver(svc: ReturnType<typeof build>, f: { raw: Buffer; mac: string }) {
  const r = await svc.webhook.handle(f.raw, f.mac);
  await new Promise((res) => setImmediate(res)); // let the webhook's scheduled trigger start
  await Promise.all(svc.pending.splice(0));
  return r;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  UserModel = conn.model(User.name, UserSchema.clone().set('autoIndex', false)) as unknown as Model<UserDocument>;
  PromoModel = conn.model(Promotion.name, PromotionSchema) as unknown as Model<PromotionDocument>;
  SessionModel = conn.model(ZaloOaRewardSession.name, ZaloOaRewardSessionSchema) as unknown as Model<ZaloOaRewardSessionDocument>;
  FollowerModel = conn.model(ZaloOaFollower.name, ZaloOaFollowerSchema) as unknown as Model<ZaloOaFollowerDocument>;
  LinkModel = conn.model(ZaloOaLink.name, ZaloOaLinkSchema) as unknown as Model<ZaloOaLinkDocument>;
  GrantModel = conn.model(ZaloOaRewardGrant.name, ZaloOaRewardGrantSchema) as unknown as Model<ZaloOaRewardGrantDocument>;
  EventModel = conn.model(ZaloOaWebhookEvent.name, ZaloOaWebhookEventSchema) as unknown as Model<ZaloOaWebhookEventDocument>;
  for (const m of [OrderModel, PromoModel, SessionModel, FollowerModel, LinkModel, GrantModel, EventModel] as Model<any>[]) await m.init();
  // UserSchema declares email_1 twice (prop `unique` + schema.index) — a pre-existing quirk that
  // makes init() fail on a fresh DB. Create the two indexes the guest logic relies on directly.
  await UserModel.collection.createIndex({ email: 1 }, { unique: true });
  await UserModel.collection.createIndex({ phone: 1 }, { unique: true, sparse: true });
});
afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  for (const m of [OrderModel, VersionModel, UserModel, PromoModel, SessionModel, FollowerModel, LinkModel, GrantModel, EventModel] as Model<any>[]) await m.deleteMany({});
  env = { ...BASE_ENV };
  rejectedTokens = new Set();
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (u, init) => {
    const url = String(u);
    if (url.startsWith('https://oauth-mock.test/v4/access_token')) {
      const code = new URLSearchParams(String((init as RequestInit).body)).get('code') ?? '';
      if (!code.startsWith('code-')) return json({ error: -14003, error_name: 'Invalid authorization code' });
      return json({ access_token: `at-${code.slice(5)}`, refresh_token: 'rt', expires_in: '3600' });
    }
    if (url.startsWith('https://graph-mock.test/v2.0/me')) {
      const token = ((init as RequestInit).headers as Record<string, string>).access_token;
      if (rejectedTokens.has(token) || !token.startsWith('at-')) return json({ error: 452, message: 'Invalid appsecret_proof' });
      return json({ error: 0, message: 'Success', id: token.slice(3) });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ZALO_USER = '3681046936240438345'; // app-scoped id from /me
const OA_UID = '24684588352919792'; // follower.id from the OA webhook

describe('Zalo OA welcome reward — integration', () => {
  it('01 + 25: real checkout still works, and a successful order opens the reward offer (20% from DB)', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0901111222');
    const order = await svc.orders.create(String(user._id), {
      items: [{ productId: String(productId), quantity: 1 }],
      shippingInfo: { recipientName: 'A', phone: '0901111222', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    } as CreateOrderDto);
    expect(order.total).toBe(200000);

    const view = await svc.rewards.openForOrder(String(user._id), String(order._id));
    expect(view).toMatchObject({
      enabled: true,
      state: RewardSessionState.ELIGIBLE,
      offer: { discountPercent: 20, minOrderValue: 50000, maxDiscountAmount: 1000000 },
      oa: { url: `https://zalo.me/${OA_ID}` },
    });
    expect(view.couponCode).toBeUndefined(); // never before the reward is assigned
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it('03–07 + 16: verified login + signed follow → existing promotion/coupon assigned, code read from DB', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0902222333');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));

    const redirect = await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    expect(redirect.url).toBe(`https://zalo.me/${OA_ID}`); // last step: follow the OA
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.FOLLOW_PENDING);

    expect(await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }))).toEqual({ ok: true, outcome: 'APPLIED' });
    const view = await svc.rewards.getStatus(String(user._id), String(order._id));
    expect(view.state).toBe(RewardSessionState.REWARD_ASSIGNED);
    expect(view.couponCode).toBe('ZALO_OA');
    expect(view.recipient).toEqual({ isOrderAccount: true });

    const session = await SessionModel.findOne().lean();
    expect(session).toMatchObject({ zaloAppUserId: ZALO_USER, oaId: OA_ID, oaUid: OA_UID, identitySource: 'SOCIAL_LOGIN' });
    const grants = await GrantModel.find().lean();
    expect(grants).toHaveLength(1);
    expect(String(grants[0].promotionId)).toBe(PROMOTION_ID);
    expect(String(grants[0].couponId)).toBe(COUPON_ID);
    expect(grants[0]).toMatchObject({ couponCode: 'ZALO_OA', oaUid: OA_UID, status: 'ASSIGNED', phoneVerified: false, resolution: RecipientResolution.SESSION_ACCOUNT, phoneSource: RewardPhoneSource.ACCOUNT });

    // 05–07: the existing records are reused; nothing new is created.
    expect(await PromoModel.countDocuments()).toBe(1);
    const promo = await PromoModel.findById(PROMOTION_ID).lean();
    expect(promo!.coupons).toHaveLength(1);
    expect(String(promo!.coupons[0]._id)).toBe(COUPON_ID);
    expect(promo!.assignedUsers.map(String)).toEqual([String(user._id)]);

    // The coupon is genuinely usable by this account at the next checkout (existing validator)…
    const validation = await svc.promotions.validateCoupons(String(user._id), { couponCodes: ['ZALO_OA'], orderTotal: 300000 });
    expect(validation.totalDiscount).toBe(60000);
    // …and was NOT applied retroactively to the completed order.
    expect((await OrderModel.findById(order._id).lean())!.discountAmount).toBe(0);
  });

  it('02 + 21: an account that already holds the reward skips the first-time flow', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0903333444');
    const first = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(first._id));
    await zaloLogin(svc, String(user._id), String(first._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));

    const second = await createOrder(user._id);
    const view = await svc.rewards.openForOrder(String(user._id), String(second._id));
    expect(view.state).toBe(RewardSessionState.ALREADY_CLAIMED);
    expect(view.couponCode).toBe('ZALO_OA'); // own existing reward, shown to its owner
    expect(await SessionModel.countDocuments({ orderId: second._id })).toBe(0);
    expect(await GrantModel.countDocuments()).toBe(1);
  });

  it('08 + 09: no linking code and no OTP anywhere — states, views, inbound text', async () => {
    expect(Object.values(RewardSessionState).join()).not.toMatch(/LINKING_CODE|OTP|VERIFY_PHONE/);
    const dir = __dirname;
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    for (const f of sources) {
      // Code only — comments legitimately explain that these mechanisms do NOT exist.
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect({ f, hit: /linkingCode|linking_code|LINKING_CODE|\botp\b|sendOtp|verifyOtp/i.test(src) }).toEqual({ f, hit: false });
    }
    // A user_send_text event (the old code-matching channel) is ignored outright.
    await seedCampaign();
    const svc = build();
    const raw = JSON.stringify({ app_id: APP_ID, sender: { id: OA_UID }, user_id_by_app: ZALO_USER, recipient: { id: OA_ID }, event_name: 'user_send_text', message: { text: 'LG-123456', msg_id: 'm1' }, timestamp: String(Date.now()) });
    const mac = computeOaWebhookMac(APP_ID, raw, JSON.parse(raw).timestamp, OA_SECRET);
    expect(await svc.webhook.handle(Buffer.from(raw), mac)).toEqual({ ok: true, outcome: 'IGNORED_EVENT' });
    expect(await FollowerModel.countDocuments()).toBe(0);
  });

  it('10: a reward phone different from the checkout phone is accepted (no OTP) → Guest; order contact unchanged', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0904444555');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    await svc.rewards.setRewardPhone(String(user._id), String(order._id), '+84 987 654 321');
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));

    const view = await svc.rewards.getStatus(String(user._id), String(order._id));
    expect(view.state).toBe(RewardSessionState.REWARD_ASSIGNED);
    expect(view.couponCode).toBe('ZALO_OA');
    expect(view.recipient).toEqual({ isOrderAccount: false, phoneMasked: '098*****21' });
    const guest = await UserModel.findOne({ phone: '0987654321' }).select('+password').lean();
    expect(guest).toMatchObject({ isGuest: true });
    expect((await OrderModel.findById(order._id).lean())!.shippingInfo.phone).toBe('0912000111');
    expect((await UserModel.findById(user._id).lean())!.phone).toBe('0904444555');
  });

  it('11: a reward phone that exists resolves that user — promotional association only, nothing about the account changes', async () => {
    await seedCampaign();
    const svc = build();
    const buyer = await createUser('0905555666');
    const existing = await createUser('0906666777');
    const before = await UserModel.findById(existing._id).select('+password +refreshToken').lean();
    const order = await createOrder(buyer._id);
    await svc.rewards.openForOrder(String(buyer._id), String(order._id));
    await svc.rewards.setRewardPhone(String(buyer._id), String(order._id), '0906666777');
    await zaloLogin(svc, String(buyer._id), String(order._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));

    const grant = await GrantModel.findOne().lean();
    expect(String(grant!.userId)).toBe(String(existing._id));
    expect(grant).toMatchObject({ resolution: RecipientResolution.PHONE_MATCH, phone: '0906666777', phoneSource: RewardPhoneSource.REWARD_INPUT, phoneVerified: false });
    const link = await LinkModel.findOne().lean();
    expect(link).toMatchObject({ phoneVerified: false, resolution: RecipientResolution.PHONE_MATCH });
    const after = await UserModel.findById(existing._id).select('+password +refreshToken').lean();
    expect({ ...after, updatedAt: undefined }).toEqual({ ...before, updatedAt: undefined });
    expect(await UserModel.countDocuments()).toBe(2); // no Guest created
  });

  it('12 + 13: an unknown phone creates a Guest that has no password and cannot log in', async () => {
    await seedCampaign();
    const svc = build();
    const buyer = await createUser('0907777888');
    const order = await createOrder(buyer._id);
    await svc.rewards.openForOrder(String(buyer._id), String(order._id));
    await svc.rewards.setRewardPhone(String(buyer._id), String(order._id), '0938123456');
    await zaloLogin(svc, String(buyer._id), String(order._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));

    const guest = await UserModel.findOne({ phone: '0938123456' }).select('+password +refreshToken').lean();
    expect(guest).toMatchObject({ isGuest: true, name: 'Khách Zalo OA', provider: 'local' });
    expect(guest!.password).toBeUndefined();
    expect(guest!.refreshToken).toBeUndefined();
    expect((await GrantModel.findOne().lean())!.resolution).toBe(RecipientResolution.GUEST_BY_PHONE);

    const auth = new AuthService(svc.users, {} as never, { log: jest.fn() } as never, {} as never, {} as never);
    await expect(auth.login({ identifier: '0938123456', password: 'anything' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('14: UID-only Guest when there is neither an account nor a phone (schema permits: placeholder email convention)', async () => {
    const svc = build();
    const r = await svc.recipients.resolveRewardRecipient({ oaId: OA_ID, sessionId: new Types.ObjectId() }, OA_UID);
    expect(r).toMatchObject({ resolution: RecipientResolution.GUEST_BY_UID, phoneSource: RewardPhoneSource.NONE, createdGuest: true, conflict: false });
    const guest = await UserModel.findById(r.userId).select('+password').lean();
    expect(guest).toMatchObject({ isGuest: true, email: `zalo_oa_${OA_UID}@guest.luxe-glow.vn` });
    expect(guest!.phone).toBeUndefined(); // never a fake phone
    expect(guest!.password).toBeUndefined();
    // Idempotent: same UID → same Guest, no duplicate.
    const again = await svc.recipients.resolveRewardRecipient({ oaId: OA_ID, sessionId: new Types.ObjectId() }, OA_UID);
    expect(String(again.userId)).toBe(String(r.userId));
    expect(await UserModel.countDocuments({ isGuest: true })).toBe(1);
  });

  it('15: a follow event alone links nothing — not without a session, nor for another Zalo identity', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0908888999');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));

    // Someone follows the OA (no session has their verified identity).
    await deliver(svc, signedFollow({ userIdByApp: '999999999999', oaUid: '111111111111' }));
    expect(await FollowerModel.countDocuments()).toBe(1);
    expect(await LinkModel.countDocuments()).toBe(0);
    expect(await GrantModel.countDocuments()).toBe(0);
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.ELIGIBLE);

    // Our customer logs in as ZALO_USER; the stranger's (newer) follow still doesn't apply.
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: '888888888888', oaUid: '222222222222' }));
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.FOLLOW_PENDING);
    expect(await GrantModel.countDocuments()).toBe(0);
  });

  it('17: invalid identity proof is rejected — bad code, foreign token, forged/replayed state, Mini App token', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0909999000');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    const { connectUrl } = await svc.rewards.prepareLink(String(user._id), String(order._id));
    const rs = new URL(connectUrl).searchParams.get('rs');
    const state = new URL((await svc.rewards.beginConnect(rs)).url).searchParams.get('state');

    expect((await svc.rewards.handleOAuthCallback({ code: 'forged', state })).url).toBe('https://shop.test/zalo-reward?result=error');
    // The state was consumed by that attempt: replaying it is rejected.
    expect((await svc.rewards.handleOAuthCallback({ code: `code-${ZALO_USER}`, state })).url).toBe('https://shop.test/zalo-reward?result=invalid');
    expect((await svc.rewards.handleOAuthCallback({ code: `code-${ZALO_USER}`, state: 'A'.repeat(43) })).url).toBe('https://shop.test/zalo-reward?result=invalid');
    expect((await svc.rewards.handleOAuthCallback({ code: `code-${ZALO_USER}`, state: { $ne: null } })).url).toBe('https://shop.test/zalo-reward?result=invalid');

    // /me rejects the token (e.g. minted for another Zalo App → appsecret_proof mismatch).
    rejectedTokens.add(`at-${ZALO_USER}`);
    const st2 = new URL((await svc.rewards.beginConnect(rs)).url).searchParams.get('state');
    expect((await svc.rewards.handleOAuthCallback({ code: `code-${ZALO_USER}`, state: st2 })).url).toBe('https://shop.test/zalo-reward?result=error');
    const s = await SessionModel.findOne().lean();
    expect(s!.zaloAppUserId).toBeUndefined();
    expect(s!.state).toBe(RewardSessionState.AWAITING_ZALO);

    // Mini App endpoint: a client-claimed identity without a valid token gets nowhere.
    env.ZALO_OA_LINK_MODE = 'mini_app';
    env.ZALO_OA_MINI_APP_ID = '194839900003483517';
    await expect(svc.rewards.bindMiniAppIdentity(rs, 'not-a-zalo-token')).rejects.toBeInstanceOf(BadRequestException);
    expect((await SessionModel.findOne().lean())!.zaloAppUserId).toBeUndefined();
  });

  it('18: duplicate OA webhook deliveries (Zalo retries) are processed once', async () => {
    await seedCampaign();
    const svc = build();
    const f = signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID });
    expect((await deliver(svc, f)).outcome).toBe('APPLIED');
    expect((await deliver(svc, f)).outcome).toBe('DUPLICATE');
    expect(await EventModel.countDocuments()).toBe(1);
    expect(await FollowerModel.countDocuments()).toBe(1);
  });

  it('19 + 20: concurrent triggers and repeated requests assign the coupon exactly once per OA UID', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0911000111');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    await FollowerModel.create({ oaId: OA_ID, appId: APP_ID, userIdByApp: ZALO_USER, oaUid: OA_UID, isFollower: true, lastEventAt: new Date() });

    await Promise.all([
      svc.rewards.onFollowerUpdated({ userIdByApp: ZALO_USER, isFollower: true }),
      svc.rewards.onFollowerUpdated({ userIdByApp: ZALO_USER, isFollower: true }),
      svc.rewards.getStatus(String(user._id), String(order._id)),
      svc.rewards.getStatus(String(user._id), String(order._id)),
    ]);
    await flush();
    for (let i = 0; i < 3; i++) await svc.rewards.getStatus(String(user._id), String(order._id));
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.REWARD_ASSIGNED);
    expect(await GrantModel.countDocuments()).toBe(1);
    expect(await LinkModel.countDocuments()).toBe(1);
    expect((await PromoModel.findById(PROMOTION_ID).lean())!.assignedUsers).toHaveLength(1);

    // Same Zalo identity, another account + another phone → ALREADY_CLAIMED, still one grant.
    const other = await createUser('0911000222');
    const order2 = await createOrder(other._id);
    await svc.rewards.openForOrder(String(other._id), String(order2._id));
    await svc.rewards.setRewardPhone(String(other._id), String(order2._id), '0977000333');
    await zaloLogin(svc, String(other._id), String(order2._id), ZALO_USER);
    const v2 = await svc.rewards.getStatus(String(other._id), String(order2._id));
    expect(v2.state).toBe(RewardSessionState.ALREADY_CLAIMED);
    expect(v2.couponCode).toBeUndefined(); // the reward belongs to another account
    expect(await GrantModel.countDocuments()).toBe(1);
    // Case D: the UID stays with its first association, no Guest for the new phone, no merge.
    expect(await LinkModel.countDocuments()).toBe(1);
    expect(String((await LinkModel.findOne().lean())!.userId)).toBe(String(user._id));
    expect(await UserModel.countDocuments({ phone: '0977000333' })).toBe(0);
    expect((await SessionModel.findOne({ orderId: order2._id }).lean())!.recipientConflict).toBe(true);
  });

  it('22: expired or inactive promotion → not eligible (before and during the flow)', async () => {
    await seedCampaign({ endDate: new Date(Date.now() - 1000) });
    const svc = build();
    const user = await createUser('0912000333');
    const order = await createOrder(user._id);
    expect(await svc.rewards.openForOrder(String(user._id), String(order._id))).toMatchObject({ state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.PROMOTION_EXPIRED });

    await PromoModel.updateOne({}, { $set: { endDate: new Date(Date.now() + 86_400_000) } });
    expect((await svc.rewards.openForOrder(String(user._id), String(order._id))).state).toBe(RewardSessionState.ELIGIBLE);
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    await PromoModel.updateOne({}, { $set: { isActive: false } }); // admin pauses the campaign mid-flow
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    expect(await svc.rewards.getStatus(String(user._id), String(order._id))).toMatchObject({ state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.PROMOTION_INACTIVE });
    expect(await GrantModel.countDocuments()).toBe(0);
    expect((await PromoModel.findById(PROMOTION_ID).lean())!.assignedUsers).toHaveLength(0);
  });

  it('23: a coupon id that is not inside the promotion is refused (ids are not confused)', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0913000444');
    const order = await createOrder(user._id);
    env.ZALO_OA_COUPON_ID = new Types.ObjectId().toString();
    expect(await svc.rewards.openForOrder(String(user._id), String(order._id))).toMatchObject({ reason: IneligibleReason.COUPON_NOT_IN_PROMOTION });
    env.ZALO_OA_COUPON_ID = PROMOTION_ID; // promotion id used as coupon id
    expect(await svc.rewards.openForOrder(String(user._id), String(order._id))).toMatchObject({ reason: IneligibleReason.CONFIG_INVALID });
  });

  it('discount mismatch and exhausted coupon (production has totalUsageLimit = 1) are not advertised', async () => {
    await seedCampaign({}, { value: 15 });
    const svc = build();
    const user = await createUser('0914000555');
    const order = await createOrder(user._id);
    expect(await svc.rewards.openForOrder(String(user._id), String(order._id))).toMatchObject({ reason: IneligibleReason.DISCOUNT_MISMATCH });
    await PromoModel.updateOne({}, { $set: { 'coupons.0.value': 20, 'coupons.0.totalUsedCount': 1 } });
    expect(await svc.rewards.openForOrder(String(user._id), String(order._id))).toMatchObject({ reason: IneligibleReason.COUPON_EXHAUSTED });
  });

  it('24: unsupported mapping (e.g. account already followed, so no follow event) → honest UNSUPPORTED_LINKING; a later signed follow still completes', async () => {
    await seedCampaign();
    env.ZALO_OA_REWARD_FOLLOW_TIMEOUT_MINUTES = '1';
    const svc = build();
    const user = await createUser('0915000666');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    await SessionModel.updateOne({}, { $set: { followPendingSince: new Date(Date.now() - 2 * 60_000) } });

    const v = await svc.rewards.getStatus(String(user._id), String(order._id));
    expect(v).toMatchObject({ state: RewardSessionState.UNSUPPORTED_LINKING, errorCode: 'FOLLOW_EVENT_NOT_RECEIVED' });
    expect(v.couponCode).toBeUndefined();
    expect(await GrantModel.countDocuments()).toBe(0);

    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.REWARD_ASSIGNED);
  });

  it('webhook security: bad signature, Bot secret, foreign app → rejected; foreign OA / stale / out-of-order → ignored', async () => {
    await seedCampaign();
    const svc = build();
    const good = signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID });
    await expect(svc.webhook.handle(good.raw, 'f'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.webhook.handle(good.raw, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.webhook.handle(signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, secret: 'bot-secret' }).raw, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, secret: 'bot-secret' }).mac)).rejects.toBeInstanceOf(UnauthorizedException);
    const foreignApp = signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, appId: '11111111111' });
    await expect(svc.webhook.handle(foreignApp.raw, foreignApp.mac)).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, oaId: '77777777777' }))).outcome).toBe('IGNORED_OA');
    expect((await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, ts: Date.now() - 6 * 3600_000 }))).outcome).toBe('IGNORED_STALE');
    expect(await FollowerModel.countDocuments()).toBe(0);

    const t = Date.now();
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, event: 'unfollow', ts: t }));
    expect((await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, event: 'follow', ts: t - 5000 }))).outcome).toBe('IGNORED_STALE');
    expect((await FollowerModel.findOne().lean())!.isFollower).toBe(false);

    env.ZALO_OA_WEBHOOK_SECRET = '';
    await expect(svc.webhook.handle(good.raw, good.mac)).rejects.toThrow('Webhook not configured');
  });

  it('an unfollowed account is not linked (must actually follow)', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0916000777');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    const t = Date.now();
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, ts: t - 10_000 }));
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, event: 'unfollow', ts: t - 5000 }));
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.FOLLOW_PENDING);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID, ts: t }));
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.REWARD_ASSIGNED);
  });

  it('status endpoints are owner-only: another customer gets 404 for the order and session', async () => {
    await seedCampaign();
    const svc = build();
    const owner = await createUser('0917000888');
    const intruder = await createUser('0917000999');
    const order = await createOrder(owner._id);
    await svc.rewards.openForOrder(String(owner._id), String(order._id));
    await expect(svc.rewards.openForOrder(String(intruder._id), String(order._id))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.rewards.getStatus(String(intruder._id), String(order._id))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.rewards.prepareLink(String(intruder._id), String(order._id))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.rewards.setRewardPhone(String(intruder._id), String(order._id), '0901234567')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('link lifecycle: rotating reference, expiry, phone locked after linking, malformed phone rejected', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0918000111');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    const first = new URL((await svc.rewards.prepareLink(String(user._id), String(order._id))).connectUrl).searchParams.get('rs');
    const second = new URL((await svc.rewards.prepareLink(String(user._id), String(order._id))).connectUrl).searchParams.get('rs');
    expect(first).not.toBe(second);
    expect((await svc.rewards.beginConnect(first)).url).toBe('https://shop.test/zalo-reward?result=invalid');
    // No order id / phone / secret in the link.
    const link = (await svc.rewards.prepareLink(String(user._id), String(order._id))).connectUrl;
    expect(link).not.toContain(String(order._id));
    expect(link).not.toContain('0918000111');

    await SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.EXPIRED);
    await expect(svc.rewards.setRewardPhone(String(user._id), String(order._id), '12345')).rejects.toBeInstanceOf(BadRequestException);

    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER); // re-issue after expiry works
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    await expect(svc.rewards.setRewardPhone(String(user._id), String(order._id), '0909000111')).rejects.toBeInstanceOf(ConflictException);
  });

  it('order eligibility: admin-created, marketplace and cancelled orders get no offer; feature off → disabled', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0919000222');
    const adminOrder = await createOrder(user._id, { createdByAdmin: true });
    const shopee = await createOrder(user._id, { externalRef: { channel: 'SHOPEE', code: 'X1' } });
    const cancelled = await createOrder(user._id, { status: 'CANCELLED' });
    expect((await svc.rewards.openForOrder(String(user._id), String(adminOrder._id))).reason).toBe(IneligibleReason.ORDER_NOT_STOREFRONT);
    expect((await svc.rewards.openForOrder(String(user._id), String(shopee._id))).reason).toBe(IneligibleReason.ORDER_NOT_STOREFRONT);
    expect((await svc.rewards.openForOrder(String(user._id), String(cancelled._id))).reason).toBe(IneligibleReason.ORDER_CANCELLED);
    env.ZALO_OA_REWARD_ENABLED = 'false';
    const ok = await createOrder(user._id);
    expect(await svc.rewards.openForOrder(String(user._id), String(ok._id))).toEqual({ enabled: false, state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.DISABLED });
    expect(await SessionModel.countDocuments()).toBe(0);
  });

  it('blocked recipient gets nothing', async () => {
    await seedCampaign();
    const svc = build();
    const buyer = await createUser('0920000333');
    await createUser('0920000444', { isBlocked: true });
    const order = await createOrder(buyer._id);
    await svc.rewards.openForOrder(String(buyer._id), String(order._id));
    await svc.rewards.setRewardPhone(String(buyer._id), String(order._id), '0920000444');
    await zaloLogin(svc, String(buyer._id), String(order._id), ZALO_USER);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    expect(await svc.rewards.getStatus(String(buyer._id), String(order._id))).toMatchObject({ state: RewardSessionState.NOT_ELIGIBLE, reason: IneligibleReason.RECIPIENT_BLOCKED });
    expect(await GrantModel.countDocuments()).toBe(0);
  });

  it('Mini App mode: personalized zalo.me/s deep link, server-verified token, then signed follow', async () => {
    await seedCampaign();
    env.ZALO_OA_LINK_MODE = 'mini_app';
    env.ZALO_OA_MINI_APP_ID = '194839900003483517';
    const svc = build();
    const user = await createUser('0921000555');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    const { connectUrl } = await svc.rewards.prepareLink(String(user._id), String(order._id));
    const u = new URL(connectUrl);
    expect(u.origin + u.pathname).toBe('https://zalo.me/s/194839900003483517/');
    expect(u.searchParams.get('utm_source')).toBe('zalo-qr');
    const rs = u.searchParams.get('rs');

    expect(await svc.rewards.bindMiniAppIdentity(rs, `at-${ZALO_USER}`)).toEqual({ state: RewardSessionState.FOLLOW_PENDING, next: 'FOLLOW_OA' });
    // A different Zalo identity cannot take over the session.
    await expect(svc.rewards.bindMiniAppIdentity(rs, 'at-5555555555')).rejects.toBeInstanceOf(ConflictException);
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    const v = await svc.rewards.getStatus(String(user._id), String(order._id));
    expect(v.state).toBe(RewardSessionState.REWARD_ASSIGNED);
    expect((await SessionModel.findOne().lean())!.identitySource).toBe('MINI_APP');
  });

  it('crash between grant row and promotion update is resumed, not duplicated', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0922000666');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    await zaloLogin(svc, String(user._id), String(order._id), ZALO_USER);
    const spy = jest.spyOn(svc.promotions, 'assignUserToProgram').mockRejectedValueOnce(new Error('db blip'));
    await deliver(svc, signedFollow({ userIdByApp: ZALO_USER, oaUid: OA_UID }));
    expect((await GrantModel.findOne().lean())!.status).toBe('PROCESSING');
    spy.mockRestore();
    const v = await svc.rewards.getStatus(String(user._id), String(order._id));
    expect(v.state).toBe(RewardSessionState.REWARD_ASSIGNED);
    expect(await GrantModel.countDocuments()).toBe(1);
    expect((await GrantModel.findOne().lean())!.status).toBe('ASSIGNED');
    expect((await PromoModel.findById(PROMOTION_ID).lean())!.assignedUsers).toHaveLength(1);
  });

  it('declined Zalo authorization returns the session to waiting, with no identity', async () => {
    await seedCampaign();
    const svc = build();
    const user = await createUser('0923000777');
    const order = await createOrder(user._id);
    await svc.rewards.openForOrder(String(user._id), String(order._id));
    const { connectUrl } = await svc.rewards.prepareLink(String(user._id), String(order._id));
    const state = new URL((await svc.rewards.beginConnect(new URL(connectUrl).searchParams.get('rs'))).url).searchParams.get('state');
    expect((await svc.rewards.handleOAuthCallback({ state, error: 'access_denied' })).url).toBe('https://shop.test/zalo-reward?result=denied');
    expect((await svc.rewards.getStatus(String(user._id), String(order._id))).state).toBe(RewardSessionState.AWAITING_ZALO);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
