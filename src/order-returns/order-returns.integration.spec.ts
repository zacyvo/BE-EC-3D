import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Order,
  OrderDocument,
  OrderSchema,
  OrderStatus,
  ReturnReason,
  ReturnStatus,
} from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { NET_ITEM_QTY_EXPR, NET_ORDER_TOTAL_EXPR, UNWIND_ITEMS_WITH_RETURNS } from '../orders/order-return-aggregation';
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
import { OrderReturnsService, estimateReturnRefund } from './order-returns.service';
import { CreateReturnRequestDto } from './dto/order-return.dto';

/**
 * Return/refund flow over a real (in-memory) MongoDB, incl. the owner's ORDER_RETURN_REQUESTED
 * Zalo Bot notification (Zalo HTTP mocked) and the return-aware revenue aggregations.
 */
jest.setTimeout(60_000);

const OWNER = 'owner-chat-aaaa1111';
const STAFF = new Types.ObjectId().toString();
const DAY = 24 * 60 * 60 * 1000;
const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/web-ec-3d/returns/a.jpg';
const ACCOUNT = { bankName: 'Vietcombank', accountNumber: '0123456789', accountHolder: 'tran thi b' };

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
  const returns = new OrderReturnsService(OrderModel, VersionModel, audit, users as never, notifications);
  return { returns, notifications };
}

/** Two lines: 2 × 200k lamp + 1 × 100k stand, 50k coupon, 30k shipping → total 480k. */
async function seedOrder(opts: { status?: OrderStatus; owner?: string; deliveredDaysAgo?: number | null; paid?: boolean; extra?: Record<string, unknown> } = {}) {
  const { status = OrderStatus.DELIVERED, owner = userId, deliveredDaysAgo = 1, paid = true, extra = {} } = opts;
  return OrderModel.create({
    userId: new Types.ObjectId(owner),
    items: [
      { productId: new Types.ObjectId(), productName: 'Đèn mặt trăng', productImage: 'x', productSlug: 'den', quantity: 2, unitPrice: 200000, subtotal: 400000, color: 'Trắng' },
      { productId: new Types.ObjectId(), productName: 'Đế gỗ', productImage: 'y', productSlug: 'de', quantity: 1, unitPrice: 100000, subtotal: 100000 },
    ],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    subtotal: 500000,
    discountAmount: 50000,
    shippingFee: 30000,
    total: 480000,
    paidAmount: paid ? 480000 : 0,
    status,
    ...(deliveredDaysAgo !== null ? { deliveredAt: new Date(Date.now() - deliveredDaysAgo * DAY) } : {}),
    ...extra,
  });
}

function requestDto(overrides: Partial<CreateReturnRequestDto> = {}): CreateReturnRequestDto {
  return {
    items: [{ itemIndex: 0, quantity: 1 }],
    reason: ReturnReason.DAMAGED,
    description: 'Đèn bị nứt chân đế khi mở hộp',
    images: [IMG],
    refundAccount: ACCOUNT,
    ...overrides,
  };
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

describe('estimateReturnRefund', () => {
  it('prorates the order discount and caps by what was paid', () => {
    const order = { subtotal: 500000, discountAmount: 50000, paidAmount: 480000 };
    expect(estimateReturnRefund(order, [{ unitPrice: 200000, quantity: 1 }])).toBe(180000);
    expect(estimateReturnRefund(order, [{ unitPrice: 200000, quantity: 2 }, { unitPrice: 100000, quantity: 1 }])).toBe(450000);
    expect(estimateReturnRefund({ ...order, paidAmount: 100000 }, [{ unitPrice: 200000, quantity: 2 }])).toBe(100000);
    expect(estimateReturnRefund({ ...order, paidAmount: 0 }, [{ unitPrice: 200000, quantity: 1 }])).toBe(0);
  });
});

describe('Eligibility (7-day window)', () => {
  it('delivered yesterday → eligible, deadline = deliveredAt + 7 days, refund account required when paid', async () => {
    const order = await seedOrder();
    const e = await build().returns.getEligibility(order._id.toString(), userId);
    expect(e.eligible).toBe(true);
    expect(e.requiresRefundAccount).toBe(true);
    expect(e.deadline!.getTime() - order.deliveredAt!.getTime()).toBe(7 * DAY);
  });

  it('delivered 8 days ago → refused', async () => {
    const order = await seedOrder({ deliveredDaysAgo: 8 });
    const svc = build();
    expect(await svc.returns.getEligibility(order._id.toString(), userId)).toMatchObject({ eligible: false });
    await expect(svc.returns.createRequest(order._id.toString(), userId, requestDto())).rejects.toThrow('quá hạn 7 ngày');
  });

  it.each([OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.CANCELLED])(
    'a %s order can not be returned',
    async (status) => {
      const order = await seedOrder({ status, deliveredDaysAgo: null });
      await expect(build().returns.createRequest(order._id.toString(), userId, requestDto())).rejects.toThrow('đã giao thành công');
    },
  );

  it('a Shopee-synced order must be returned on Shopee', async () => {
    const order = await seedOrder({ extra: { externalRef: { channel: 'SHOPEE', code: 'S1' } } });
    await expect(build().returns.createRequest(order._id.toString(), userId, requestDto())).rejects.toThrow('SHOPEE');
  });

  it('legacy order without deliveredAt → window starts at the first DELIVERED version, and is persisted', async () => {
    const order = await seedOrder({ deliveredDaysAgo: null });
    await VersionModel.create({ orderId: order._id, versionNumber: 1, snapshot: { status: 'PENDING' }, changedBy: STAFF });
    await VersionModel.create({ orderId: order._id, versionNumber: 2, snapshot: { status: 'DELIVERED' }, changedBy: STAFF });
    const svc = build();
    expect((await svc.returns.getEligibility(order._id.toString(), userId)).eligible).toBe(true);
    const res = await svc.returns.createRequest(order._id.toString(), userId, requestDto());
    expect(res.deliveredAt).toBeInstanceOf(Date);
  });

  it("refuses another user's order", async () => {
    const order = await seedOrder({ owner: otherUserId });
    await expect(build().returns.getEligibility(order._id.toString(), userId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Customer creates a return request', () => {
  it('saves items/estimate, keeps order DELIVERED, owner gets exactly one Zalo message', async () => {
    const svc = build();
    const order = await seedOrder();
    const id = order._id.toString();
    const res = await svc.returns.createRequest(id, userId, requestDto());
    expect(res.status).toBe(OrderStatus.DELIVERED);
    expect(res.returnRequest).toMatchObject({
      status: ReturnStatus.REQUESTED,
      reason: ReturnReason.DAMAGED,
      estimatedRefund: 180000,
      requestedByName: 'Trần Thị B',
      refundAccount: { accountHolder: 'TRAN THI B' },
    });
    expect(res.returnRequest!.items[0]).toMatchObject({ itemIndex: 0, productName: 'Đèn mặt trăng', color: 'Trắng', quantity: 1, unitPrice: 200000 });
    expect(res.returnRequest!.history).toHaveLength(1);
    expect(await VersionModel.countDocuments({ orderId: order._id })).toBe(1);

    await svc.notifications.runOnce();
    await svc.notifications.runOnce();
    const jobs = await JobModel.find().lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ eventType: NotificationEventType.ORDER_RETURN_REQUESTED, status: NotificationStatus.ACCEPTED });
    const text = sentTexts()[0];
    expect(text).toContain(`Trần Thị B yêu cầu trả hàng đơn #${id.slice(-8).toUpperCase()}`);
    expect(text).toContain('Hàng bị vỡ/hư hỏng khi vận chuyển');
    expect(text).toContain('- Đèn mặt trăng (Trắng) x 1');
    expect(text).toContain('Hoàn tiền dự kiến: 180.000đ');
    expect(text).toContain(`https://admin.luxe-glow.vn/returns?search=${id}`);
  });

  it('only one request per order', async () => {
    const svc = build();
    const order = await seedOrder();
    await svc.returns.createRequest(order._id.toString(), userId, requestDto());
    await expect(svc.returns.createRequest(order._id.toString(), userId, requestDto())).rejects.toThrow('đã có yêu cầu');
  });

  it('two concurrent requests → exactly one is saved', async () => {
    const svc = build();
    const order = await seedOrder();
    const results = await Promise.allSettled([
      svc.returns.createRequest(order._id.toString(), userId, requestDto()),
      svc.returns.createRequest(order._id.toString(), userId, requestDto()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it.each([
    [[{ itemIndex: 0, quantity: 3 }], 'vượt quá'],
    [[{ itemIndex: 5, quantity: 1 }], 'không thuộc đơn hàng'],
    [[{ itemIndex: 1, quantity: 1 }, { itemIndex: 1, quantity: 1 }], 'trùng'],
  ])('rejects invalid items %j', async (items, message) => {
    const order = await seedOrder();
    await expect(build().returns.createRequest(order._id.toString(), userId, requestDto({ items }))).rejects.toThrow(message);
    expect((await OrderModel.findById(order._id).lean())?.returnRequest).toBeUndefined();
  });

  it('paid order without refund account → refused; unpaid order → account optional', async () => {
    const svc = build();
    const paid = await seedOrder();
    await expect(svc.returns.createRequest(paid._id.toString(), userId, requestDto({ refundAccount: undefined }))).rejects.toThrow('tài khoản ngân hàng');
    const unpaid = await seedOrder({ paid: false });
    const res = await svc.returns.createRequest(unpaid._id.toString(), userId, requestDto({ refundAccount: undefined }));
    expect(res.returnRequest!.estimatedRefund).toBe(0);
  });
});

describe('Full flow', () => {
  it('request → approve → ship → receive → inspect (pass) → refund → COMPLETED, revenue nets out the return', async () => {
    const { returns } = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto());

    let res = await returns.approve(id, STAFF, { shopNote: 'Gửi về 1 Lê Lợi, Q1' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.APPROVED, shopNote: 'Gửi về 1 Lê Lợi, Q1' });

    res = await returns.submitShipment(id, userId, { carrierName: 'GHN', trackingCode: 'GHN123456' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.SHIPPING_BACK, shipment: { trackingCode: 'GHN123456', carrierName: 'GHN' } });
    // The customer may correct the tracking code while it is on the way.
    res = await returns.submitShipment(id, userId, { trackingCode: 'GHN999999' });
    expect(res.returnRequest!.shipment!.trackingCode).toBe('GHN999999');
    await expect(returns.cancelRequest(id, userId)).rejects.toBeInstanceOf(BadRequestException);

    res = await returns.markReceived(id, STAFF, {});
    expect(res.returnRequest!.status).toBe(ReturnStatus.RECEIVED);
    expect(res.returnRequest!.receivedAt).toBeInstanceOf(Date);

    await expect(returns.inspect(id, STAFF, { passed: true, refundAmount: 500000 })).rejects.toThrow('vượt quá');
    res = await returns.inspect(id, STAFF, { passed: true, returnShippingRefund: 25000, note: 'Đúng là nứt' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.REFUNDING, refundAmount: 180000, returnShippingRefund: 25000 });

    res = await returns.completeRefund(id, STAFF, { transferRef: 'FT2610310001' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.COMPLETED, refundTransferRef: 'FT2610310001' });
    expect(res.returnRequest!.refundedAt).toBeInstanceOf(Date);
    expect(res.returnRequest!.history.map((h) => h.status)).toEqual([
      ReturnStatus.REQUESTED,
      ReturnStatus.APPROVED,
      ReturnStatus.SHIPPING_BACK,
      ReturnStatus.SHIPPING_BACK,
      ReturnStatus.RECEIVED,
      ReturnStatus.REFUNDING,
      ReturnStatus.COMPLETED,
    ]);
    expect(res.status).toBe(OrderStatus.DELIVERED);
    expect(await VersionModel.countDocuments({ orderId: order._id })).toBe(7);

    const [net] = await OrderModel.aggregate([{ $match: { _id: order._id } }, { $group: { _id: null, total: { $sum: NET_ORDER_TOTAL_EXPR } } }]);
    expect(net.total).toBe(480000 - 180000);
    const lines = await OrderModel.aggregate([
      { $match: { _id: order._id } },
      ...UNWIND_ITEMS_WITH_RETURNS,
      { $project: { qty: NET_ITEM_QTY_EXPR } },
    ]);
    expect(lines.map((l) => l.qty)).toEqual([1, 1]);
  });

  it('an open (not yet settled) return does not change revenue', async () => {
    const { returns } = build();
    const order = await seedOrder();
    await returns.createRequest(order._id.toString(), userId, requestDto());
    const [net] = await OrderModel.aggregate([{ $match: { _id: order._id } }, { $group: { _id: null, total: { $sum: NET_ORDER_TOTAL_EXPR } } }]);
    expect(net.total).toBe(480000);
  });

  it('unpaid order: inspection passed with nothing to refund → COMPLETED right away', async () => {
    const { returns } = build();
    const order = await seedOrder({ paid: false });
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto({ refundAccount: undefined }));
    await returns.approve(id, STAFF, {});
    // Dropped off at the shop: received straight from APPROVED.
    await returns.markReceived(id, STAFF, {});
    const res = await returns.inspect(id, STAFF, { passed: true });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.COMPLETED, refundAmount: 0 });
  });

  it('inspection failed → REJECTED at INSPECTION with the reason', async () => {
    const { returns } = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto());
    await returns.approve(id, STAFF, {});
    await returns.markReceived(id, STAFF, {});
    await expect(returns.inspect(id, STAFF, { passed: false })).rejects.toThrow('lý do');
    const res = await returns.inspect(id, STAFF, { passed: false, note: 'Sản phẩm bị trầy do người dùng' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.REJECTED, rejectedAt: 'INSPECTION', rejectReason: 'Sản phẩm bị trầy do người dùng' });
  });

  it('shop rejects the request → REJECTED at REQUEST, nothing else possible', async () => {
    const { returns } = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto());
    const res = await returns.reject(id, STAFF, { reason: 'Ảnh không cho thấy lỗi' });
    expect(res.returnRequest).toMatchObject({ status: ReturnStatus.REJECTED, rejectedAt: 'REQUEST' });
    await expect(returns.approve(id, STAFF, {})).rejects.toThrow('đã bị từ chối');
    await expect(returns.submitShipment(id, userId, { trackingCode: 'GHN123456' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('customer withdraws before shipping → CANCELLED and can not request again', async () => {
    const { returns } = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto());
    await returns.approve(id, STAFF, {});
    const res = await returns.cancelRequest(id, userId);
    expect(res.returnRequest!.status).toBe(ReturnStatus.CANCELLED);
    await expect(returns.createRequest(id, userId, requestDto())).rejects.toThrow('đã có yêu cầu');
  });

  it('two staff approving at once → exactly one wins', async () => {
    const { returns } = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await returns.createRequest(id, userId, requestDto());
    const results = await Promise.allSettled([returns.approve(id, STAFF, {}), returns.reject(id, STAFF, { reason: 'Không hợp lệ' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const fresh = await OrderModel.findById(order._id).lean();
    expect(fresh!.returnRequest!.history).toHaveLength(2);
  });
});

describe('Admin list', () => {
  it('filters by return status, searches by phone and counts open requests', async () => {
    const { returns } = build();
    const a = await seedOrder();
    const b = await seedOrder();
    await seedOrder(); // no return
    await returns.createRequest(a._id.toString(), userId, requestDto());
    await returns.createRequest(b._id.toString(), userId, requestDto());
    await returns.reject(b._id.toString(), STAFF, { reason: 'Không hợp lệ' });

    const all = await returns.findAllAdmin({ page: 1, limit: 20 });
    expect(all.total).toBe(2);
    expect(all.counts).toMatchObject({ REQUESTED: 1, REJECTED: 1, OPEN: 1 });
    const requested = await returns.findAllAdmin({ page: 1, limit: 20, status: ReturnStatus.REQUESTED });
    expect(requested.data.map((o: { _id: Types.ObjectId }) => o._id.toString())).toEqual([a._id.toString()]);
    expect((await returns.findAllAdmin({ page: 1, limit: 20, search: '0912345' })).total).toBe(2);
  });
});
