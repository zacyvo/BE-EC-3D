import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AdjustmentSettlementStatus,
  AdjustmentSettlementType,
  Order,
  OrderAdjustmentStatus,
  OrderDocument,
  OrderSchema,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
} from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from './schemas/order-version.schema';
import { OrdersService } from './orders.service';
import { OrderAdjustmentService } from './order-adjustment.service';
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
import { NotificationEventType } from '../zalo-bot/zalo-bot.constants';
import { BankTransferService } from '../payments/bank-transfer.service';
import { BankTransferConfigService } from '../payments/bank-transfer.config';
import { decodeVietQrPayload } from '../payments/vietqr';
import { StaffRole } from '../auth/decorators/roles.decorator';

/**
 * "Điều chỉnh đơn hàng" over a real (in-memory) MongoDB: Super Admin proposes → customer accepts /
 * rejects → difference against what was PAID is refunded or collected (COD / VietQR), with the
 * owner's Zalo Bot notifications (Zalo HTTP mocked).
 */
jest.setTimeout(60_000);

const OWNER = 'owner-chat-aaaa1111';
const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();
const staffId = new Types.ObjectId().toString();
const lampId = new Types.ObjectId().toString();
const vaseId = new Types.ObjectId().toString();
const STAFF = { staffId, staffName: 'superadmin@luxe-glow.vn' };
const REFUND_ACCOUNT = { bankName: 'Techcombank', accountNumber: '19035551234', accountHolder: 'TRAN THI B' };

const PRODUCTS: Record<string, unknown> = {
  [lampId]: {
    name: 'Đèn ngủ in 3D', slug: 'den', stock: 10, finalPrice: 250000, images: ['den.jpg'],
    colors: [{ name: 'Đen', images: ['den-den.jpg'] }, { name: 'Trắng', images: ['den-trang.jpg'] }], sizes: [],
    variants: [{ color: 'Trắng', finalPrice: 270000 }],
  },
  [vaseId]: { name: 'Bình hoa', slug: 'binh', stock: 1, finalPrice: 120000, images: ['binh.jpg'], colors: [], sizes: [] },
};

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;

function build() {
  const config = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
  const cfg = new ZaloBotConfigService(config);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService & { log: jest.Mock };
  const recipients = new ZaloOwnerRecipientService(RecipientModel, cfg, audit);
  const notifications = new OrderNotificationService(OrderModel, JobModel, cfg, new ZaloBotClient(cfg), recipients, audit);
  jest.spyOn(notifications, 'kick').mockImplementation(() => undefined);
  const bankTransfer = new BankTransferService(OrderModel, new BankTransferConfigService(config));
  const users = { findById: jest.fn(async () => ({ name: 'Trần Thị B', email: 'b@example.com', isGuest: false })) };
  const products = {
    findById: jest.fn(async (id: string) => {
      if (!PRODUCTS[id]) throw new NotFoundException('Product not found');
      return PRODUCTS[id];
    }),
  };
  const mail = { sendOrderAdjustmentProposed: jest.fn().mockResolvedValue(undefined) };
  const orders = new OrdersService(
    OrderModel, VersionModel, products as never, {} as never, audit, {} as never, users as never, {} as never,
    notifications, bankTransfer,
  );
  const adjustments = new OrderAdjustmentService(
    OrderModel, VersionModel, orders, products as never, audit, users as never, notifications, config,
    bankTransfer, mail as never,
  );
  return { orders, adjustments, notifications, audit, mail };
}

/** Lamp (Đen) x2 @250k + 22k shipping = 522k; `paid` → a confirmed VietQR transfer of the total. */
async function seedOrder({ paid = true, status = OrderStatus.PROCESSING }: { paid?: boolean; status?: OrderStatus } = {}) {
  const _id = new Types.ObjectId();
  return OrderModel.create({
    _id,
    userId: new Types.ObjectId(userId),
    items: [{
      productId: new Types.ObjectId(lampId), productName: 'Đèn ngủ in 3D', productImage: 'den-den.jpg', productSlug: 'den',
      quantity: 2, unitPrice: 250000, subtotal: 500000, color: 'Đen',
    }],
    shippingInfo: { recipientName: 'Trần Thị B', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP. Hồ Chí Minh' },
    subtotal: 500000,
    shippingFee: 22000,
    total: 522000,
    status,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    paidAmount: paid ? 522000 : 0,
    payment: {
      status: paid ? PaymentStatus.PAID : PaymentStatus.PENDING_PAYMENT,
      reference: `LG${_id.toString().slice(-8).toUpperCase()}`,
      amount: 522000,
      currency: 'VND',
      bankAccount: { bankBin: '970436', bankName: 'Vietcombank', accountNumber: '0011001932418', accountName: 'CONG TY TNHH LUXE GLOW' },
      verificationStatus: paid ? PaymentVerificationStatus.CONFIRMED : PaymentVerificationStatus.NOT_REPORTED,
      history: [],
    },
  });
}

const lamp = (quantity: number, color = 'Đen', unitPrice?: number) => ({ productId: lampId, quantity, color, ...(unitPrice !== undefined ? { unitPrice } : {}) });

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
    FRONTEND_URL: 'https://luxe-glow.vn',
    PAYMENT_BANK_ENABLED: 'true',
    PAYMENT_QR_PROVIDER: 'LOCAL_VIETQR',
    PAYMENT_BANK_BIN: '970436',
    PAYMENT_BANK_NAME: 'Vietcombank',
    PAYMENT_BANK_ACCOUNT_NUMBER: '0011001932418',
    PAYMENT_BANK_ACCOUNT_NAME: 'CONG TY TNHH LUXE GLOW',
  };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify({ ok: true, result: { message_id: 'm1' } }), { status: 200 }),
  );
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('Lower total on a paid order → refund the excess', () => {
  it('proposal leaves the order unchanged, acceptance applies it, admin records the refund', async () => {
    const svc = build();
    const order = await seedOrder();
    const id = order._id.toString();

    const proposed = await svc.adjustments.propose(id, STAFF, {
      items: [lamp(1)], reason: 'Bạn đặt dư 1 đèn — shop bớt lại 1', expectedVersion: order.currentVersion,
    });
    // Nothing applied yet.
    expect(proposed.total).toBe(522000);
    expect(proposed.items[0].quantity).toBe(2);
    expect(proposed.adjustment).toMatchObject({
      number: 1, status: OrderAdjustmentStatus.PROPOSED, paidAmountAtProposal: 522000, balance: -250000,
      after: { subtotal: 250000, shippingFee: 22000, total: 272000 },
    });
    expect(svc.mail.sendOrderAdjustmentProposed).toHaveBeenCalledWith(
      'b@example.com',
      expect.objectContaining({ beforeTotal: 522000, afterTotal: 272000, balance: -250000, orderUrl: `https://luxe-glow.vn/orders/${id}` }),
    );

    // Can't ship while the customer hasn't answered.
    await expect(
      svc.orders.updateStatus(id, { status: OrderStatus.SHIPPED }, staffId, StaffRole.SUPER_ADMIN),
    ).rejects.toThrow(/chờ khách xác nhận điều chỉnh/);

    // A refund needs an account.
    await expect(svc.adjustments.accept(id, userId, { number: 1 })).rejects.toThrow(/tài khoản ngân hàng/);
    // Other customers can't answer.
    await expect(svc.adjustments.accept(id, otherUserId, { number: 1, refundAccount: REFUND_ACCOUNT })).rejects.toBeInstanceOf(ForbiddenException);

    const accepted = await svc.adjustments.accept(id, userId, { number: 1, refundAccount: REFUND_ACCOUNT });
    expect(accepted).toMatchObject({ total: 272000, subtotal: 250000, paidAmount: 522000 });
    expect(accepted.items).toHaveLength(1);
    expect(accepted.items[0]).toMatchObject({ quantity: 1, unitPrice: 250000 });
    expect(accepted.adjustment?.status).toBe(OrderAdjustmentStatus.ACCEPTED);
    expect(accepted.adjustment?.settlement).toMatchObject({
      type: AdjustmentSettlementType.REFUND, amount: 250000, status: AdjustmentSettlementStatus.PENDING, refundAccount: REFUND_ACCOUNT,
    });
    // The confirmed VietQR payment record itself is untouched.
    expect(accepted.payment).toMatchObject({ status: PaymentStatus.PAID, amount: 522000 });

    await svc.notifications.runOnce();
    const text = sentTexts()[0];
    expect(text).toContain('KHÁCH ĐỒNG Ý ĐIỀU CHỈNH ĐƠN');
    expect(text).toContain('Cần hoàn lại cho khách: 250.000đ');
    expect(text).toContain('19035551234');

    // A new adjustment waits for the refund to be recorded.
    await expect(svc.adjustments.propose(id, STAFF, { items: [lamp(1, 'Trắng')], reason: 'x' })).rejects.toThrow(/chưa hoàn tất/);

    const done = await svc.adjustments.completeSettlement(id, STAFF, { transferRef: 'FT123' });
    expect(done.paidAmount).toBe(272000);
    expect(done.adjustment?.settlement).toMatchObject({ status: AdjustmentSettlementStatus.COMPLETED, transferRef: 'FT123', completedBy: staffId });
    await expect(svc.adjustments.completeSettlement(id, STAFF, {})).rejects.toBeInstanceOf(ConflictException);
    // propose, accept, refund
    expect(await VersionModel.countDocuments({ orderId: order._id })).toBe(3);
  });
});

describe('Higher total → customer pays the rest', () => {
  it('reject keeps the order; a 2nd proposal paid by VietQR gets its own reference, QR and confirmation', async () => {
    const svc = build();
    const order = await seedOrder();
    const id = order._id.toString();

    await svc.adjustments.propose(id, STAFF, { items: [lamp(2, 'Trắng')], reason: 'Đổi sang màu Trắng' });
    const rejected = await svc.adjustments.reject(id, userId, { number: 1, reason: 'Tôi muốn giữ màu Đen' });
    expect(rejected.adjustment).toMatchObject({ status: OrderAdjustmentStatus.REJECTED, rejectReason: 'Tôi muốn giữ màu Đen' });
    expect(rejected).toMatchObject({ total: 522000 });
    expect(rejected.items[0].color).toBe('Đen');
    await expect(svc.adjustments.accept(id, userId, { number: 1, extraPaymentMethod: PaymentMethod.COD })).rejects.toThrow(/đã từ chối/);

    // 2nd proposal: Trắng (variant price 270k) x2 + 1 vase.
    const p2 = await svc.adjustments.propose(id, STAFF, {
      items: [lamp(2, 'Trắng'), { productId: vaseId, quantity: 1 }], reason: 'Thêm bình hoa bạn quên đặt',
    });
    expect(p2.adjustment).toMatchObject({ number: 2, balance: 682000 - 522000 });
    expect(p2.adjustmentHistory?.[0]).toMatchObject({ number: 1, status: OrderAdjustmentStatus.REJECTED });
    expect(p2.adjustment?.after.items[0]).toMatchObject({ color: 'Trắng', unitPrice: 270000, productImage: 'den-trang.jpg' });

    await expect(svc.adjustments.accept(id, userId, { number: 2 })).rejects.toThrow(/hình thức thanh toán/);
    const accepted = await svc.adjustments.accept(id, userId, { number: 2, extraPaymentMethod: PaymentMethod.BANK_TRANSFER });
    const reference = `LG${id.slice(-8).toUpperCase()}T2`;
    expect(accepted.total).toBe(682000);
    expect(accepted.adjustment?.settlement).toMatchObject({
      type: AdjustmentSettlementType.EXTRA_PAYMENT, method: PaymentMethod.BANK_TRANSFER, amount: 160000, reference,
    });

    const instructions = await svc.adjustments.getExtraPaymentForUser(id, userId);
    expect(instructions).toMatchObject({ amount: 160000, reference, payable: true, status: AdjustmentSettlementStatus.PENDING });
    expect(decodeVietQrPayload(instructions.qrPayload!)).toMatchObject({ amount: 160000, description: reference });

    const reported = await svc.adjustments.reportExtraPayment(id, userId);
    expect(reported).toMatchObject({ status: AdjustmentSettlementStatus.AWAITING_CONFIRMATION, alreadyReported: false });
    expect((await svc.adjustments.reportExtraPayment(id, userId)).alreadyReported).toBe(true);

    // Owner: rejection of #1, acceptance of #2 (scoped dedup → both delivered), transfer report.
    await svc.notifications.runOnce();
    await svc.notifications.runOnce();
    const texts = sentTexts();
    expect(texts.some((t) => t.includes('KHÁCH TỪ CHỐI ĐIỀU CHỈNH ĐƠN') && t.includes('Tôi muốn giữ màu Đen'))).toBe(true);
    expect(texts.some((t) => t.includes('KHÁCH ĐỒNG Ý ĐIỀU CHỈNH ĐƠN') && t.includes(reference))).toBe(true);
    expect(texts.some((t) => t.includes('CHUYỂN KHOẢN PHẦN THÊM') && t.includes('160.000đ'))).toBe(true);
    const jobs = await JobModel.find().lean();
    expect(jobs.map((j) => j.dedupKey).sort()).toEqual([
      `${NotificationEventType.ADJUSTMENT_PAYMENT_REPORTED}#adj2:ZALO_BOT:${id}:${OWNER}`,
      `${NotificationEventType.ORDER_ADJUSTMENT_RESPONDED}#adj1:ZALO_BOT:${id}:${OWNER}`,
      `${NotificationEventType.ORDER_ADJUSTMENT_RESPONDED}#adj2:ZALO_BOT:${id}:${OWNER}`,
    ].sort());

    const done = await svc.adjustments.completeSettlement(id, STAFF, {});
    expect(done.paidAmount).toBe(682000);
    expect((await svc.adjustments.getExtraPaymentForUser(id, userId)).payable).toBe(false);
  });

  it('COD remainder is completed automatically when the order is delivered', async () => {
    const svc = build();
    const order = await seedOrder();
    const id = order._id.toString();
    await svc.adjustments.propose(id, STAFF, { items: [lamp(3)], reason: 'Thêm 1 đèn' });
    const accepted = await svc.adjustments.accept(id, userId, { number: 1, extraPaymentMethod: PaymentMethod.COD });
    expect(accepted.adjustment?.settlement).toMatchObject({ method: PaymentMethod.COD, amount: 250000 });

    await svc.orders.updateStatus(id, { status: OrderStatus.SHIPPED }, staffId, StaffRole.SUPER_ADMIN);
    const delivered = await svc.orders.updateStatus(id, { status: OrderStatus.DELIVERED }, staffId, StaffRole.SUPER_ADMIN);
    expect(delivered.paidAmount).toBe(772000);
    expect(delivered.adjustment?.settlement).toMatchObject({ status: AdjustmentSettlementStatus.COMPLETED, completedBy: 'system' });
  });
});

describe('Guards', () => {
  it('unpaid order: no settlement, the VietQR amount follows the new total', async () => {
    const svc = build();
    const order = await seedOrder({ paid: false, status: OrderStatus.PENDING });
    const id = order._id.toString();
    const p = await svc.adjustments.propose(id, STAFF, { items: [lamp(1)], reason: 'Bớt 1 đèn' });
    expect(p.adjustment?.balance).toBe(0);
    const accepted = await svc.adjustments.accept(id, userId, { number: 1 });
    expect(accepted.adjustment?.settlement).toBeUndefined();
    expect(accepted.total).toBe(272000);
    expect(accepted.payment?.amount).toBe(272000);
  });

  it('refuses no-op, stale and non-adjustable proposals; withdraw / cancel close the proposal', async () => {
    const svc = build();
    const order = await seedOrder();
    const id = order._id.toString();

    await expect(svc.adjustments.propose(id, STAFF, { items: [lamp(2)], reason: 'x' })).rejects.toThrow(/Không có thay đổi/);
    await expect(
      svc.adjustments.propose(id, STAFF, { items: [lamp(1)], reason: 'x', expectedVersion: order.currentVersion + 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.adjustments.propose(id, STAFF, { items: [lamp(2), { productId: vaseId, quantity: 5 }], reason: 'x' }),
    ).rejects.toThrow(/Không đủ hàng/);
    // Keeping a line at its original price after a catalog price change is allowed.
    const kept = await svc.adjustments.propose(id, STAFF, { items: [lamp(2, 'Đen', 250000)], shippingFee: 0, reason: 'Miễn phí ship' });
    expect(kept.adjustment?.after).toMatchObject({ total: 500000, shippingFee: 0 });
    await expect(svc.adjustments.propose(id, STAFF, { items: [lamp(1)], reason: 'x' })).rejects.toThrow(/thu hồi/);

    const withdrawn = await svc.adjustments.withdraw(id, staffId, 'Gửi nhầm');
    expect(withdrawn.adjustment?.status).toBe(OrderAdjustmentStatus.WITHDRAWN);
    await expect(svc.adjustments.accept(id, userId, { number: 1 })).rejects.toThrow(/thu hồi/);

    await svc.adjustments.propose(id, STAFF, { items: [lamp(1)], reason: 'Bớt 1' });
    const cancelled = await svc.orders.updateStatus(id, { status: OrderStatus.CANCELLED }, staffId, StaffRole.SUPER_ADMIN);
    expect(cancelled.adjustment?.status).toBe(OrderAdjustmentStatus.WITHDRAWN);
    await expect(svc.adjustments.propose(id, STAFF, { items: [lamp(1)], reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unconfirmed customer transfer report blocks adjusting', async () => {
    const svc = build();
    const order = await seedOrder({ paid: false, status: OrderStatus.PENDING });
    await OrderModel.updateOne({ _id: order._id }, { 'payment.verificationStatus': PaymentVerificationStatus.AWAITING_CONFIRMATION });
    await expect(svc.adjustments.propose(order._id.toString(), STAFF, { items: [lamp(1)], reason: 'x' })).rejects.toThrow(/xác nhận thanh toán/);
  });
});
