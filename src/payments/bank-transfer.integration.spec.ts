import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Order,
  OrderDocument,
  OrderSchema,
  OrderStatus,
  PaymentConfirmationSource,
  PaymentHistoryAction,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
} from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { OrdersService } from '../orders/orders.service';
import { AdminOrdersController } from '../orders/orders.controller';
import { CreateOrderDto } from '../orders/dto/order.dto';
import { AuditService } from '../audit/audit.service';
import { User, UserSchema } from '../users/schemas/user.schema';
import { ROLES_KEY, StaffRole } from '../auth/decorators/roles.decorator';
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
import { ZaloBotWebhookController } from '../zalo-bot/zalo-bot-webhook.controller';
import { ZaloPaymentCommandHandler } from '../zalo-bot/zalo-payment-command.handler';
import { BankTransferConfigService } from './bank-transfer.config';
import { BankTransferService } from './bank-transfer.service';
import { PaymentConfirmationService } from './payment-confirmation.service';
import { PaymentEvent, PaymentEventDocument, PaymentEventResult, PaymentEventSchema } from './schemas/payment-event.schema';
import { decodeVietQrPayload } from './vietqr';

/**
 * VietQR bank transfer end to end over a real (in-memory) MongoDB — real OrdersService checkout,
 * real webhook controller; only Zalo's HTTP API is mocked:
 * checkout → instructions/QR → "Tôi đã chuyển khoản" → admin confirms (CMS or Zalo Bot) → PAID.
 */
jest.setTimeout(60_000);

const OWNER = 'owner-chat-aaaa1111';
const ADMIN = 'admin-zalo-bbbb2222';
const STRANGER = 'stranger-cccc3333';
const SECRET = 'webhook-secret-123';
const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();
const staffId = new Types.ObjectId().toString();
const productId = new Types.ObjectId().toString();

const BASE_ENV: Record<string, string> = {
  PAYMENT_BANK_ENABLED: 'true',
  PAYMENT_QR_PROVIDER: 'LOCAL_VIETQR',
  PAYMENT_BANK_BIN: '970436',
  PAYMENT_BANK_NAME: 'Vietcombank',
  PAYMENT_BANK_ACCOUNT_NUMBER: '0011001932418',
  PAYMENT_BANK_ACCOUNT_NAME: 'CONG TY TNHH LUXE GLOW',
  ZALO_BOT_ENABLED: 'true',
  ZALO_BOT_TOKEN: 'test-token-123',
  ZALO_BOT_BASE_URL: 'https://zalo.test',
  ZALO_BOT_WEBHOOK_SECRET: SECRET,
  ZALO_OWNER_CHAT_IDS: OWNER,
  ZALO_PAYMENT_ADMIN_IDS: `${ADMIN}:Chủ shop`,
  ZALO_BOT_ADMIN_URL: 'https://admin.luxe-glow.vn',
};

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let EventModel: Model<PaymentEventDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
let sendStatus: number;

function build() {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const cfg = new ZaloBotConfigService(config);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService & { log: jest.Mock };
  const recipients = new ZaloOwnerRecipientService(RecipientModel, cfg, audit);
  const client = new ZaloBotClient(cfg);
  const notifications = new OrderNotificationService(OrderModel, JobModel, cfg, client, recipients, audit);
  jest.spyOn(notifications, 'kick').mockImplementation(() => undefined);
  const bankTransfer = new BankTransferService(OrderModel, new BankTransferConfigService(config));
  const confirmation = new PaymentConfirmationService(OrderModel, VersionModel, EventModel, audit);
  const users = { findById: jest.fn(async () => ({ name: 'Trần Thị B' })) };
  const products = {
    findById: jest.fn(async () => ({
      name: 'Đèn ngủ in 3D', slug: 'den', stock: 10, finalPrice: 259000, images: ['img'], colors: [], sizes: [],
    })),
  };
  const promotions = {
    validateCoupons: jest.fn(async () => ({ totalDiscount: 50000, appliedCoupons: [{ code: 'GIAM50', name: 'Giảm 50k', discountAmount: 50000 }] })),
    markUsed: jest.fn(),
  };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    products as never,
    { clearCart: jest.fn() } as never,
    audit,
    promotions as never,
    users as never,
    {} as never,
    notifications,
    bankTransfer,
  );
  const handler = new ZaloPaymentCommandHandler(cfg, client, confirmation);
  const webhook = new ZaloBotWebhookController(cfg, recipients, handler);
  return { orders, notifications, bankTransfer, confirmation, handler, webhook, audit };
}

function checkoutDto(extra: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    items: [{ productId, quantity: 2 }],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    ...extra,
  } as CreateOrderDto;
}

let msgSeq = 0;
function zaloText(text: string, opts: { from?: string; messageId?: string; chatType?: string; date?: number } = {}) {
  const from = opts.from ?? ADMIN;
  return {
    ok: true,
    result: {
      event_name: 'message.text.received',
      message: {
        message_id: opts.messageId ?? `msg-${++msgSeq}`,
        date: opts.date ?? Date.now(),
        message_type: 'CHAT_TEXT',
        from: { id: from, display_name: 'Ai đó', is_bot: false },
        chat: { id: from, chat_type: opts.chatType ?? 'PRIVATE' },
        text,
      },
    },
  };
}

/** Zalo sendMessage calls: { chatId, text }. */
function sent(): { chatId: string; text: string }[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/sendMessage'))
    .map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string);
      return { chatId: body.chat_id, text: body.text };
    });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  JobModel = conn.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
  RecipientModel = conn.model(ZaloBotRecipient.name, ZaloBotRecipientSchema) as unknown as Model<ZaloBotRecipientDocument>;
  EventModel = conn.model(PaymentEvent.name, PaymentEventSchema) as unknown as Model<PaymentEventDocument>;
  conn.model(User.name, UserSchema); // admin list populates the customer
  await Promise.all([OrderModel.init(), VersionModel.init(), JobModel.init(), RecipientModel.init(), EventModel.init()]);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  env = { ...BASE_ENV };
  sendStatus = 200;
  await Promise.all([
    OrderModel.deleteMany({}),
    VersionModel.deleteMany({}),
    JobModel.deleteMany({}),
    RecipientModel.deleteMany({}),
    EventModel.deleteMany({}),
  ]);
  fetchMock?.mockRestore();
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () =>
    sendStatus === 200
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 'zalo-out-1' } }), { status: 200 })
      : new Response('upstream error', { status: sendStatus }),
  );
});

// ─── Customer side ──────────────────────────────────────────────────────────

describe('VietQR checkout + payment instructions', () => {
  it('creates a bank-transfer order with a server-side amount, reference and bank snapshot', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER, couponCodes: ['GIAM50'] }));

    expect(order.total).toBe(259000 * 2 - 50000); // discounted final payable amount
    expect(order.paymentMethod).toBe(PaymentMethod.BANK_TRANSFER);
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.paidAmount).toBe(0);
    expect(order.payment).toMatchObject({
      status: PaymentStatus.PENDING_PAYMENT,
      verificationStatus: PaymentVerificationStatus.NOT_REPORTED,
      reference: `LG${order._id.toString().slice(-8).toUpperCase()}`,
      amount: 468000,
      currency: 'VND',
      bankAccount: {
        bankBin: '970436', bankName: 'Vietcombank', accountNumber: '0011001932418', accountName: 'CONG TY TNHH LUXE GLOW',
      },
    });
    expect(order.payment!.history.map((h) => h.action)).toEqual([PaymentHistoryAction.INSTRUCTIONS_CREATED]);
  });

  it('keeps COD as the default and stores no payment instructions', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto());
    expect(order.paymentMethod).toBe(PaymentMethod.COD);
    expect(order.payment).toBeUndefined();
    await expect(orders.getPaymentForUser(order._id.toString(), userId)).rejects.toThrow(BadRequestException);
  });

  it('returns a QR encoding the order account, amount and reference — identical on reload', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const first = await orders.getPaymentForUser(order._id.toString(), userId);
    const again = await orders.getPaymentForUser(order._id.toString(), userId);

    expect(first.payable).toBe(true);
    expect(again).toEqual(first);
    expect(decodeVietQrPayload(first.qrPayload!)).toMatchObject({
      bankBin: '970436', accountNumber: '0011001932418', amount: 518000, description: first.reference,
    });
    expect(await OrderModel.countDocuments()).toBe(1); // reloading never creates an order
  });

  it('gives different orders different references', async () => {
    const { orders } = build();
    const a = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const b = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    expect(a.payment!.reference).not.toBe(b.payment!.reference);
  });

  it('retries with a longer reference if one is already taken', async () => {
    const { orders, bankTransfer } = build();
    const a = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    // Simulate two order ids sharing their last 8 chars: the first attempt reuses a's reference.
    const real = bankTransfer.buildInitialPayment.bind(bankTransfer);
    jest
      .spyOn(bankTransfer, 'buildInitialPayment')
      .mockImplementationOnce((id, total, len) => ({ ...real(id, total, len), reference: a.payment!.reference }));
    const b = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    expect(b.payment!.reference).toBe(`LG${b._id.toString().slice(-16).toUpperCase()}`);
    expect(await OrderModel.countDocuments()).toBe(2);
  });

  it('does not let another customer read the instructions', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await expect(orders.getPaymentForUser(order._id.toString(), otherUserId)).rejects.toThrow(ForbiddenException);
    await expect(orders.reportPaymentByUser(order._id.toString(), otherUserId)).rejects.toThrow(ForbiddenException);
  });

  it('refuses bank-transfer checkout when the bank account is not configured', async () => {
    env.PAYMENT_BANK_ACCOUNT_NUMBER = '';
    const { orders, bankTransfer } = build();
    expect(bankTransfer.isAvailable()).toBe(false);
    await expect(orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }))).rejects.toThrow(
      'tạm thời không khả dụng',
    );
    env.PAYMENT_BANK_ENABLED = 'false';
    env.PAYMENT_BANK_ACCOUNT_NUMBER = BASE_ENV.PAYMENT_BANK_ACCOUNT_NUMBER;
    await expect(orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }))).rejects.toThrow(BadRequestException);
    expect(await OrderModel.countDocuments()).toBe(0);
  });

  it('keeps the bank account of an existing order when the shop config changes', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    env.PAYMENT_BANK_ACCOUNT_NUMBER = '999999999';
    const info = await orders.getPaymentForUser(order._id.toString(), userId);
    expect(info.bank.accountNumber).toBe('0011001932418');
    expect(decodeVietQrPayload(info.qrPayload!).accountNumber).toBe('0011001932418');
  });

  it('follows the order total while unpaid (VAT e-invoice request adds 10%)', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const updated = await orders.requestEInvoiceByUser(order._id.toString(), userId, {
      buyerType: 'INDIVIDUAL', buyerName: 'Nguyễn Văn A', address: '1 Lê Lợi', email: 'a@b.vn',
    } as never);
    const info = await orders.getPaymentForUser(order._id.toString(), userId);
    expect(info.amount).toBe(updated.total);
    expect(decodeVietQrPayload(info.qrPayload!).amount).toBe(updated.total);
    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.payment!.history.map((h) => h.action)).toContain(PaymentHistoryAction.AMOUNT_UPDATED);
  });

  it('"Tôi đã chuyển khoản" records a claim only — the order stays unpaid — and is idempotent', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const res = await orders.reportPaymentByUser(order._id.toString(), userId);
    expect(res.alreadyReported).toBe(false);
    expect(res.verificationStatus).toBe(PaymentVerificationStatus.AWAITING_CONFIRMATION);
    expect(res.paymentStatus).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(res.customerReportedAt).toBeInstanceOf(Date);

    const again = await orders.reportPaymentByUser(order._id.toString(), userId);
    expect(again.alreadyReported).toBe(true);

    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.paidAmount).toBe(0);
    expect(stored!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(stored!.payment!.history.filter((h) => h.action === PaymentHistoryAction.CUSTOMER_REPORTED)).toHaveLength(1);
    expect(stored!.pendingNotificationEvents).toContain(NotificationEventType.PAYMENT_REPORTED);
  });

  it('tells the owner on Zalo that the customer reported a transfer (claim, with the command to send)', async () => {
    const { orders, notifications } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await orders.reportPaymentByUser(order._id.toString(), userId);
    await notifications.runOnce();
    const toOwner = sent().filter((m) => m.chatId === OWNER).map((m) => m.text);
    const report = toOwner.find((t) => t.includes('KHÁCH BÁO ĐÃ CHUYỂN KHOẢN'));
    expect(report).toContain(`Nội dung chuyển khoản: ${order.payment!.reference}`);
    expect(report).toContain('CHƯA phải xác nhận đã nhận tiền');
    expect(report).toContain(`Đơn hàng: ${order.payment!.reference}\nĐã thanh toán`);
    expect(toOwner.find((t) => t.includes('ĐƠN HÀNG MỚI'))).toContain('Chuyển khoản ngân hàng (VietQR)');
  });

  it('shows no QR and refuses a report once the order is cancelled', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await orders.cancelByUser(order._id.toString(), userId);
    const info = await orders.getPaymentForUser(order._id.toString(), userId);
    expect(info.payable).toBe(false);
    expect(info.qrPayload).toBeNull();
    await expect(orders.reportPaymentByUser(order._id.toString(), userId)).rejects.toThrow('Đơn hàng đã bị hủy');
  });

  it('does not let the status form mark an unpaid bank-transfer order paid via paidAmount', async () => {
    const { orders } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await expect(
      orders.updateStatus(order._id.toString(), { status: OrderStatus.CONFIRMED, paidAmount: order.total }, staffId, StaffRole.ADMIN),
    ).rejects.toThrow('Xác nhận đã thanh toán');
    // Re-sending the unchanged amount (what the form does) still works.
    const ok = await orders.updateStatus(order._id.toString(), { status: OrderStatus.CONFIRMED, paidAmount: 0 }, staffId, StaffRole.ADMIN);
    expect(ok.status).toBe(OrderStatus.CONFIRMED);
  });
});

// ─── Admin CMS ──────────────────────────────────────────────────────────────

describe('Admin CMS confirmation', () => {
  it('is restricted to SUPER_ADMIN and ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.confirmPayment)).toEqual([
      StaffRole.SUPER_ADMIN,
      StaffRole.ADMIN,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.getPaymentEvents)).toEqual([
      StaffRole.SUPER_ADMIN,
      StaffRole.ADMIN,
    ]);
  });

  it('marks the order PAID with an audit trail and moves it to "Đang chuẩn bị hàng" — even if the customer never reported', async () => {
    const { orders, confirmation, audit } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const paid = await confirmation.confirmByStaff(order._id.toString(), { staffId, staffName: 'admin@luxe-glow.vn' }, order.total);

    expect(paid.status).toBe(OrderStatus.PROCESSING); // PENDING → Đang chuẩn bị hàng
    expect(paid.delivery).toBeUndefined(); // shipping untouched
    expect(paid.paidAmount).toBe(order.total);
    expect(paid.payment).toMatchObject({
      status: PaymentStatus.PAID,
      verificationStatus: PaymentVerificationStatus.CONFIRMED,
      confirmationSource: PaymentConfirmationSource.ADMIN_CMS,
      confirmedBy: staffId,
      confirmedByName: 'admin@luxe-glow.vn',
    });
    expect(paid.payment!.confirmedAt).toBeInstanceOf(Date);
    expect(paid.payment!.history.map((h) => h.action)).toEqual([PaymentHistoryAction.INSTRUCTIONS_CREATED, PaymentHistoryAction.CONFIRMED]);
    expect(await VersionModel.countDocuments({ orderId: order._id, changeNote: /Xác nhận đã thanh toán/ })).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_CONFIRMED', module: 'payments', actorId: staffId }));
    const events = await confirmation.eventsForOrder(order._id.toString());
    expect(events).toEqual([expect.objectContaining({ result: PaymentEventResult.SUCCESS, source: 'ADMIN_CMS', amount: order.total })]);
  });

  it('moves a CONFIRMED order to PROCESSING too, but leaves a shipped order where it is', async () => {
    const { orders, confirmation } = build();
    const confirmed = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await orders.updateStatus(confirmed._id.toString(), { status: OrderStatus.CONFIRMED }, staffId, StaffRole.ADMIN);
    expect((await confirmation.confirmByStaff(confirmed._id.toString(), { staffId })).status).toBe(OrderStatus.PROCESSING);

    const shipped = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await orders.updateStatus(shipped._id.toString(), { status: OrderStatus.SHIPPED }, staffId, StaffRole.ADMIN);
    const paid = await confirmation.confirmByStaff(shipped._id.toString(), { staffId });
    expect(paid.status).toBe(OrderStatus.SHIPPED);
    expect(paid.payment!.status).toBe(PaymentStatus.PAID);
  });

  it('a paid order can no longer be cancelled directly by the customer (only a cancel request)', async () => {
    const { orders, confirmation } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await confirmation.confirmByStaff(order._id.toString(), { staffId });
    await expect(orders.cancelByUser(order._id.toString(), userId)).rejects.toThrow('vui lòng gửi yêu cầu hủy');
  });

  it('refuses a second confirmation without a second success', async () => {
    const { orders, confirmation } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await confirmation.confirmByStaff(order._id.toString(), { staffId });
    await expect(confirmation.confirmByStaff(order._id.toString(), { staffId })).rejects.toThrow(ConflictException);
    const results = (await EventModel.find({ orderId: order._id }).lean()).map((e) => e.result).sort();
    expect(results).toEqual([PaymentEventResult.ALREADY_PAID, PaymentEventResult.SUCCESS]);
    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.payment!.history.filter((h) => h.action === PaymentHistoryAction.CONFIRMED)).toHaveLength(1);
  });

  it('lets exactly one of several concurrent confirmations win', async () => {
    const { orders, confirmation } = build();
    const order = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => confirmation.confirmByStaff(order._id.toString(), { staffId })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await EventModel.countDocuments({ orderId: order._id, result: PaymentEventResult.SUCCESS })).toBe(1);
    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.payment!.history.filter((h) => h.action === PaymentHistoryAction.CONFIRMED)).toHaveLength(1);
    expect(stored!.currentVersion).toBe(2);
  });

  it('refuses COD, cancelled and stale-amount confirmations', async () => {
    const { orders, confirmation } = build();
    const cod = await orders.create(userId, checkoutDto());
    await expect(confirmation.confirmByStaff(cod._id.toString(), { staffId })).rejects.toThrow(
      'không sử dụng phương thức chuyển khoản ngân hàng',
    );

    const bt = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await expect(confirmation.confirmByStaff(bt._id.toString(), { staffId }, bt.total - 1000)).rejects.toThrow('vừa thay đổi');

    await orders.cancelByUser(bt._id.toString(), userId);
    await expect(confirmation.confirmByStaff(bt._id.toString(), { staffId })).rejects.toThrow('đã bị hủy');
    const stored = await OrderModel.findById(bt._id).lean();
    expect(stored!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(stored!.paidAmount).toBe(0);
  });
});

// ─── Zalo Bot command ──────────────────────────────────────────────────────

describe('Zalo Bot payment command', () => {
  async function bankOrder() {
    const ctx = build();
    const order = await ctx.orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    fetchMock.mockClear();
    return { ...ctx, order, ref: order.payment!.reference };
  }

  it('confirms an order for an authorized admin and replies with the stored values', async () => {
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));

    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.payment).toMatchObject({
      status: PaymentStatus.PAID,
      confirmationSource: PaymentConfirmationSource.ZALO_ADMIN_BOT,
      confirmedBy: `zalo:${ADMIN}`,
      confirmedByName: 'Chủ shop',
    });
    expect(stored!.status).toBe(OrderStatus.PROCESSING);
    expect(sent()).toEqual([
      {
        chatId: ADMIN,
        text: [
          '✅ XÁC NHẬN THANH TOÁN THÀNH CÔNG',
          '',
          `🛍 Đơn hàng: ${ref}`,
          '💰 Số tiền: 518.000đ',
          '💳 Phương thức: Chuyển khoản ngân hàng',
          '✅ Trạng thái: Đã thanh toán',
          '📦 Đơn hàng: Đang chuẩn bị hàng',
          '👤 Xác nhận bởi: Chủ shop',
        ].join('\n'),
      },
    ]);
    const [event] = await EventModel.find({ orderId: order._id }).lean();
    expect(event).toMatchObject({
      result: PaymentEventResult.SUCCESS,
      source: 'ZALO_ADMIN_BOT',
      senderZaloId: ADMIN,
      previousStatus: PaymentStatus.PENDING_PAYMENT,
      newStatus: PaymentStatus.PAID,
      amount: 518000,
      replyStatus: 'ACCEPTED',
    });
    expect(event.providerMessageId).toMatch(/^msg-/);
  });

  it('accepts the unaccented form and the admin display code', async () => {
    const { webhook, order } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`don hang: #${order._id.toString().slice(-8)}\nda thanh toan`));
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PAID);
  });

  it('processes a re-delivered message once (no 2nd update, no 2nd reply)', async () => {
    const { webhook, order, ref } = await bankOrder();
    const body = zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`, { messageId: 'same-id' });
    await Promise.all([webhook.receive(SECRET, body), webhook.receive(SECRET, body)]);
    await webhook.receive(SECRET, body);

    expect(sent()).toHaveLength(1);
    expect(await EventModel.countDocuments({})).toBe(1);
    const stored = await OrderModel.findById(order._id).lean();
    expect(stored!.payment!.history.filter((h) => h.action === PaymentHistoryAction.CONFIRMED)).toHaveLength(1);
  });

  it('answers "already confirmed" for a new command on a paid order and changes nothing', async () => {
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    const before = await OrderModel.findById(order._id).lean();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    expect(sent()[1].text).toBe(`Đơn hàng ${ref} đã được xác nhận thanh toán trước đó.`);
    const after = await OrderModel.findById(order._id).lean();
    expect(after!.currentVersion).toBe(before!.currentVersion);
    expect(after!.payment!.confirmedAt).toEqual(before!.payment!.confirmedAt);
  });

  it('rejects an unauthorized sender before touching any order (display name / content do not matter)', async () => {
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`, { from: STRANGER }));
    const body = zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`, { from: STRANGER });
    (body.result.message.from as { display_name: string }).display_name = 'Chủ shop';
    await webhook.receive(SECRET, body);
    await webhook.receive(SECRET, zaloText('Đơn hàng hôm nay sao rồi?', { from: STRANGER }));

    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(sent().map((m) => m.text)).toEqual(['Bạn không có quyền xác nhận thanh toán.', 'Bạn không có quyền xác nhận thanh toán.']);
    expect(sent().every((m) => !m.text.includes(ref))).toBe(true);
    expect(await EventModel.countDocuments({})).toBe(0);
  });

  it('rejects a wrong webhook secret without processing anything', async () => {
    const { webhook, order, ref } = await bankOrder();
    await expect(webhook.receive('wrong-secret', zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`))).rejects.toThrow('Unauthorized');
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(sent()).toHaveLength(0);
  });

  it.each([
    ['an invalid command', (ref: string) => `Đơn hàng: ${ref}\nChưa thanh toán`, 'chưa đúng định dạng'],
    ['multiple orders', (ref: string) => `Đơn hàng: ${ref}, LG11112222\nĐã thanh toán`, 'chỉ được xác nhận 1 đơn hàng'],
    ['an unknown order', () => 'Đơn hàng: LGFFFFFFFF\nĐã thanh toán', 'Không tìm thấy đơn hàng LGFFFFFFFF. Vui lòng kiểm tra lại mã đơn.'],
  ])('explains %s and leaves the order unpaid', async (_label, text, expected) => {
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(text(ref)));
    expect(sent()[0].text).toContain(expected);
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
  });

  it('refuses cancelled and COD orders with a clear reason', async () => {
    const { webhook, orders, order, ref } = await bankOrder();
    await orders.cancelByUser(order._id.toString(), userId);
    const cod = await orders.create(userId, checkoutDto());
    fetchMock.mockClear();

    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    await webhook.receive(SECRET, zaloText(`Đơn hàng: #${cod._id.toString().slice(-8)}\nĐã thanh toán`));
    expect(sent().map((m) => m.text)).toEqual([
      expect.stringContaining('đã bị hủy nên không thể xác nhận thanh toán'),
      'Đơn hàng này không sử dụng phương thức chuyển khoản ngân hàng.',
    ]);
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
  });

  it('refuses group chats and stale commands', async () => {
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`, { chatType: 'GROUP' }));
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`, { date: Date.now() - 31 * 60 * 1000 }));
    expect(sent().map((m) => m.text)).toEqual([
      expect.stringContaining('cuộc trò chuyện riêng'),
      expect.stringContaining('quá 30 phút'),
    ]);
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
  });

  it('replies with a generic message (no internals) when the database fails', async () => {
    const { webhook, confirmation, order, ref } = await bankOrder();
    jest.spyOn(confirmation, 'resolveOrder').mockRejectedValueOnce(new Error('MongoNetworkError: connect ECONNREFUSED 10.0.0.5:27017'));
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    expect(sent()[0].text).toBe('Hệ thống đang gặp sự cố, chưa xác nhận được thanh toán. Vui lòng thử lại sau ít phút.');
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(await EventModel.findOne({}).lean()).toMatchObject({ result: PaymentEventResult.ERROR });
  });

  it('keeps the confirmation when the Zalo reply fails', async () => {
    const { webhook, order, ref } = await bankOrder();
    sendStatus = 500;
    await expect(webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`))).resolves.toEqual({ received: true, handled: true });
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PAID);
    expect(await EventModel.findOne({}).lean()).toMatchObject({ result: PaymentEventResult.SUCCESS, replyStatus: 'FAILED:HTTP_500' });
  });

  it('is visible in the admin order list right after the Zalo confirmation (also searchable by reference)', async () => {
    const { webhook, orders, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    const list = await orders.findAllAdmin({ page: 1, limit: 20 });
    expect((list.data[0] as OrderDocument).payment!.status).toBe(PaymentStatus.PAID);
    const found = await orders.findAllAdmin({ page: 1, limit: 20, search: ref.toLowerCase() });
    expect(found.total).toBe(1);
  });

  it('"Danh sách" lists unpaid bank-transfer orders, customer-reported first, for admins only', async () => {
    const { webhook, orders, ref } = await bankOrder();
    const reported = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await orders.reportPaymentByUser(reported._id.toString(), userId);
    const paid = await orders.create(userId, checkoutDto({ paymentMethod: PaymentMethod.BANK_TRANSFER }));
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${paid.payment!.reference}\nĐã thanh toán`));
    await orders.create(userId, checkoutDto()); // COD — never listed
    fetchMock.mockClear();

    await webhook.receive(SECRET, zaloText('Danh sách', { from: STRANGER }));
    expect(sent()).toHaveLength(0); // strangers get silence

    await webhook.receive(SECRET, zaloText('danh sach don cho xac nhan thanh toan', { messageId: 'list-1' }));
    await webhook.receive(SECRET, zaloText('danh sach don cho xac nhan thanh toan', { messageId: 'list-1' })); // redelivery
    expect(sent()).toHaveLength(1);
    const text = sent()[0].text;
    expect(text).toContain('📋 ĐƠN CHỜ XÁC NHẬN THANH TOÁN (2)');
    expect(text.indexOf(reported.payment!.reference)).toBeLessThan(text.indexOf(ref));
    expect(text).toContain(`1) ${reported.payment!.reference} · 518.000đ · Người nhận · báo CK`);
    expect(text).toContain('🔔 Khách đã báo chuyển khoản (1):');
    expect(text).toContain('⏳ Khách chưa báo chuyển khoản (1):');
    expect(text).not.toContain(paid.payment!.reference);
    expect(await EventModel.countDocuments({ action: 'LIST_PENDING', result: PaymentEventResult.LISTED })).toBe(1);
  });

  it('answers "Hướng dẫn" with the command list and an empty list when nothing is pending', async () => {
    const { webhook, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    fetchMock.mockClear();
    await webhook.receive(SECRET, zaloText('Hướng dẫn'));
    await webhook.receive(SECRET, zaloText('/ds'));
    expect(sent()[0].text).toContain('🤖 LỆNH QUẢN TRỊ LUXE GLOW');
    expect(sent()[1].text).toBe('✅ Không có đơn chuyển khoản nào đang chờ xác nhận thanh toán.');
  });

  it('keeps the existing chat enrollment and stays silent for normal messages', async () => {
    const { webhook } = await bankOrder();
    await webhook.receive(SECRET, zaloText('Xin chào bot', { from: STRANGER }));
    expect(await RecipientModel.countDocuments({ chatId: STRANGER, status: 'PENDING' })).toBe(1);
    expect(sent()).toHaveLength(0);
  });

  it('does nothing when no payment admin is configured', async () => {
    env.ZALO_PAYMENT_ADMIN_IDS = '';
    const { webhook, order, ref } = await bankOrder();
    await webhook.receive(SECRET, zaloText(`Đơn hàng: ${ref}\nĐã thanh toán`));
    expect((await OrderModel.findById(order._id).lean())!.payment!.status).toBe(PaymentStatus.PENDING_PAYMENT);
    expect(sent().map((m) => m.text)).toEqual(['Bạn không có quyền xác nhận thanh toán.']);
  });
});
