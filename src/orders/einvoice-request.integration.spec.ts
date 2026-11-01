import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  EInvoiceBuyerType,
  EInvoiceRequestStatus,
  Order,
  OrderDocument,
  OrderSchema,
  OrderStatus,
} from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from './schemas/order-version.schema';
import { OrdersService } from './orders.service';
import { computeOrderVat } from './einvoice-request.util';
import { CreateOrderDto, EInvoiceRequestDto } from './dto/order.dto';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';
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
import { EInvoice, EInvoiceDocument, EInvoiceSchema } from '../einvoice/schemas/einvoice.schema';
import { Contract, ContractSchema } from '../contracts/schemas/contract.schema';
import { EasyInvoiceClientService } from '../einvoice/easyinvoice-client.service';
import { EInvoiceService } from '../einvoice/einvoice.service';

/**
 * Customer VAT e-invoice request over a real (in-memory) MongoDB, Zalo + EasyInvoice HTTP mocked:
 * request (+10% VAT, owner notified) → shop approves/rejects → invoice issued → emailed.
 */
jest.setTimeout(60_000);

const OWNER = 'owner-chat-aaaa1111';
const userId = new Types.ObjectId().toString();
const staffId = new Types.ObjectId().toString();
const productId = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let JobModel: Model<NotificationJobDocument>;
let RecipientModel: Model<ZaloBotRecipientDocument>;
let InvoiceModel: Model<EInvoiceDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
let mail: { sendEInvoiceIssued: jest.Mock };

const COMPANY: EInvoiceRequestDto = {
  buyerType: EInvoiceBuyerType.COMPANY,
  buyerName: 'Nguyễn Văn A',
  companyName: 'Công ty TNHH Ánh Sáng',
  taxCode: '0312345678',
  address: '12 Nguyễn Huệ, Bến Nghé, TP.HCM',
  email: 'KeToan@AnhSang.vn',
};

function build() {
  const cfg = new ZaloBotConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const recipients = new ZaloOwnerRecipientService(RecipientModel, cfg, audit);
  const notifications = new OrderNotificationService(OrderModel, JobModel, cfg, new ZaloBotClient(cfg), recipients, audit);
  jest.spyOn(notifications, 'kick').mockImplementation(() => undefined);
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
  );
  const config = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
  const einvoices = new EInvoiceService(
    InvoiceModel,
    conn.model(Contract.name, ContractSchema) as never,
    OrderModel as never,
    new EasyInvoiceClientService(config),
    {} as never,
    audit,
    new JwtService(),
    config,
    {} as never,
    mail as never,
  );
  return { orders, notifications, einvoices };
}

async function seedOrder(status: OrderStatus, extra: Record<string, unknown> = {}) {
  return OrderModel.create({
    userId: new Types.ObjectId(userId),
    items: [
      { productId: new Types.ObjectId(), productName: 'Đèn', productImage: 'x', productSlug: 'den', quantity: 1, unitPrice: 259000, subtotal: 259000 },
    ],
    shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    subtotal: 259000,
    shippingFee: 22000,
    total: 281000,
    status,
    ...extra,
  });
}

/** Request made before 2026-11-02: the VAT was added on top of the total. */
const LEGACY = {
  vatAmount: 25900,
  total: 281000 + 25900,
  einvoiceRequest: {
    status: EInvoiceRequestStatus.PENDING, buyerType: 'COMPANY', buyerName: 'Nguyễn Văn A', companyName: 'Công ty TNHH Ánh Sáng',
    taxCode: '0312345678', address: '1 Lê Lợi', email: 'ketoan@anhsang.vn', vatRate: 10, vatAmount: 25900, requestedAt: new Date(),
  },
};

function zaloTexts(): string[] {
  return fetchMock.mock.calls
    .filter((c) => !String(c[0]).startsWith('http://ei.test/'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string).text);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  JobModel = conn.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
  RecipientModel = conn.model(ZaloBotRecipient.name, ZaloBotRecipientSchema) as unknown as Model<ZaloBotRecipientDocument>;
  InvoiceModel = conn.model(EInvoice.name, EInvoiceSchema) as unknown as Model<EInvoiceDocument>;
  await Promise.all([OrderModel.init(), JobModel.init(), RecipientModel.init(), VersionModel.init(), InvoiceModel.init()]);
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
    InvoiceModel.deleteMany({ isDeleted: { $in: [true, false] } }),
  ]);
  env = {
    ZALO_BOT_ENABLED: 'true',
    ZALO_BOT_TOKEN: '999:integration_test_token',
    ZALO_OWNER_CHAT_IDS: OWNER,
    ZALO_BOT_REQUEST_TIMEOUT_MS: '1000',
    ADMIN_URL: 'https://admin.luxe-glow.vn',
    EASYINVOICE_API_URL: 'http://ei.test',
    EASYINVOICE_PATTERN: '1C26TLG',
    FRONTEND_URL: 'https://luxe-glow.vn',
  };
  mail = { sendEInvoiceIssued: jest.fn().mockResolvedValue(undefined) };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const resource = String(url);
    if (resource.endsWith('api/publish/importAndIssueInvoice')) {
      const body = JSON.parse((init as RequestInit).body as string);
      const ikey = /<Ikey>(.*?)<\/Ikey>/.exec(body.XmlData)?.[1];
      return new Response(
        JSON.stringify({
          Status: 2,
          ErrorCode: '0',
          Data: { Pattern: '1C26TLG', Invoices: [{ Ikey: ikey, InvoiceStatus: 1, No: '00000077', IssueDate: '31/10/2026' }] },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (resource.endsWith('api/publish/getInvoicePdf')) {
      return new Response('%PDF-1.4 fake', { headers: { 'content-type': 'application/pdf' } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 'm1' } }), { status: 200 });
  });
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('computeOrderVat', () => {
  const ORDER = {
    items: [
      { productName: 'A', quantity: 2, unitPrice: 100000, subtotal: 200000, color: 'Trắng' },
      { productName: 'B', quantity: 1, unitPrice: 100000, subtotal: 100000 },
    ],
    discountAmount: 30001,
    shippingFee: 25000,
  };
  /** What EInvoiceService.computeItems makes of a line. */
  const invoiced = (l: { quantity: number; unitPrice: number; discountAmount: number }) => {
    const total = Math.round(l.quantity * l.unitPrice - l.discountAmount);
    return total + Math.round(total / 10);
  };

  it('prices include VAT: before-VAT lines whose invoice total is exactly what the customer pays', () => {
    const res = computeOrderVat(ORDER);
    const paid = 300000 - 30001 + 25000;
    expect(res.lines.map((l) => l.name)).toEqual(['A (Trắng)', 'B', 'Phí vận chuyển']);
    expect(res.lines.reduce((s, l) => s + invoiced(l), 0)).toBe(paid);
    expect(res.totalBeforeTax + res.vatAmount).toBe(paid);
    expect(res.lines[1]).toMatchObject({ unitPrice: 90909, discountAmount: 9091, total: 81818, vatAmount: 8182 });
  });

  it('a 1đ VAT rounding gap moves on to the next line (468 000đ has no exact before-VAT amount)', () => {
    const res = computeOrderVat({
      items: [{ productName: 'Đèn', quantity: 2, unitPrice: 259000, subtotal: 518000 }],
      discountAmount: 50000,
      shippingFee: 22000,
    });
    expect(res.lines[0]).toMatchObject({ unitPrice: 235454.5, discountAmount: 45455, total: 425454, vatAmount: 42545 });
    expect(res.lines[1]).toMatchObject({ unitPrice: 20001, total: 20001, vatAmount: 2000 });
    expect(res.lines.reduce((s, l) => s + invoiced(l), 0)).toBe(490000);
  });

  it('older requests (VAT on top): order amounts are before VAT, VAT 10% per line', () => {
    const res = computeOrderVat(ORDER, 10, { pricesIncludeVat: false });
    expect(res.lines.map((l) => l.discountAmount)).toEqual([20001, 10000, 0]);
    expect(res.lines[0].name).toBe('A (Trắng)');
    expect(res.lines[2]).toMatchObject({ name: 'Phí vận chuyển', total: 25000, vatAmount: 2500 });
    expect(res.totalBeforeTax).toBe(300000 - 30001 + 25000);
    expect(res.vatAmount).toBe(18000 + 9000 + 2500);
  });
});

describe('EInvoiceRequestDto validation', () => {
  const errorsOf = async (body: object) =>
    (await validate(plainToInstance(EInvoiceRequestDto, body))).map((e) => e.property);

  it('company needs company name + a 10/13-digit tax code', async () => {
    expect(await errorsOf(COMPANY)).toEqual([]);
    expect(await errorsOf({ ...COMPANY, taxCode: '0312345678-001' })).toEqual([]);
    expect(await errorsOf({ ...COMPANY, taxCode: undefined, companyName: '' })).toEqual(
      expect.arrayContaining(['taxCode', 'companyName']),
    );
    expect(await errorsOf({ ...COMPANY, taxCode: '123' })).toEqual(['taxCode']);
  });

  it('individual: tax code optional, email + address required', async () => {
    const base = { buyerType: 'INDIVIDUAL', buyerName: 'Lê C', address: 'Hà Nội', email: 'c@x.vn' };
    expect(await errorsOf(base)).toEqual([]);
    expect(await errorsOf({ ...base, taxCode: '079123456789' })).toEqual([]);
    expect(await errorsOf({ ...base, taxCode: 'abc' })).toEqual(['taxCode']);
    expect(await errorsOf({ ...base, email: 'nope', address: ' ' })).toEqual(expect.arrayContaining(['email', 'address']));
  });
});

describe('Request at checkout', () => {
  it('total unchanged (prices include VAT), stores the request, owner gets ORDER_CREATED + EINVOICE_REQUESTED', async () => {
    const svc = build();
    const dto = {
      items: [{ productId, quantity: 2 }],
      shippingInfo: { recipientName: 'Người nhận', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
      couponCodes: ['GIAM50'],
      einvoiceRequest: COMPANY,
    } as CreateOrderDto;
    const order = await svc.orders.create(userId, dto);
    expect(order.subtotal).toBe(518000);
    expect(order.shippingFee).toBe(22000); // TP.HCM
    expect(order.vatAmount).toBe(0);
    expect(order.total).toBe(518000 - 50000 + 22000);
    expect(order.einvoiceRequest).toMatchObject({
      status: EInvoiceRequestStatus.PENDING,
      companyName: 'Công ty TNHH Ánh Sáng',
      email: 'ketoan@anhsang.vn',
      vatRate: 10,
      vatAmount: 44545, // included in the 490 000đ (see computeOrderVat)
      requestedByName: 'Trần Thị B',
    });

    await svc.notifications.runOnce();
    const jobs = await JobModel.find().lean();
    expect(jobs.map((j) => j.eventType).sort()).toEqual([NotificationEventType.EINVOICE_REQUESTED, NotificationEventType.ORDER_CREATED]);
    expect(jobs.every((j) => j.status === NotificationStatus.ACCEPTED)).toBe(true);
    const texts = zaloTexts();
    const created = texts.find((t) => t.includes('ĐƠN HÀNG MỚI'))!;
    expect(created).not.toContain('VAT');
    const request = texts.find((t) => t.includes('YÊU CẦU XUẤT HOÁ ĐƠN'))!;
    const id = order._id.toString();
    expect(request).toContain(`Trần Thị B yêu cầu xuất hoá đơn VAT cho đơn #${id.slice(-8).toUpperCase()}`);
    expect(request).toContain('MST: 0312345678');
    expect(request).toContain('Email nhận hoá đơn: ke****@anhsang.vn');
    expect(request).toContain('Tổng thanh toán: 490.000đ (đã gồm VAT, khách không trả thêm)');
    expect(request).toContain('Tiền trước thuế: 445.455đ');
    expect(request).toContain('Thuế GTGT 10%: 44.545đ');
    expect(request).not.toContain('trước khi giao hàng');
    expect(request).toContain(`https://admin.luxe-glow.vn/orders?search=${id}`);
  });

  it('no request → no VAT, no extra notification', async () => {
    const svc = build();
    const order = await svc.orders.create(userId, {
      items: [{ productId, quantity: 1 }],
      shippingInfo: { recipientName: 'N', phone: '0912345689', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    } as CreateOrderDto);
    expect(order.vatAmount).toBe(0);
    expect(order.total).toBe(259000 + 22000);
    expect(order.einvoiceRequest).toBeUndefined();
    expect((await OrderModel.findById(order._id).lean())?.pendingNotificationEvents).toEqual([NotificationEventType.ORDER_CREATED]);
  });
});

describe('Request after the order was placed', () => {
  it('PROCESSING order: total unchanged, version saved, owner notified once', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PROCESSING);
    const res = await svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    expect(res.vatAmount).toBe(0);
    expect(res.total).toBe(281000);
    expect(res.einvoiceRequest?.vatAmount).toBe(25545);
    expect(res.einvoiceRequest?.status).toBe(EInvoiceRequestStatus.PENDING);
    expect(await VersionModel.countDocuments({ orderId: order._id })).toBe(1);

    await svc.notifications.runOnce();
    await svc.notifications.runOnce();
    expect(zaloTexts()).toHaveLength(1);
    expect(zaloTexts()[0]).toContain('YÊU CẦU XUẤT HOÁ ĐƠN ĐIỆN TỬ');
  });

  it('only one request per order', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PENDING);
    await svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    await expect(svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY)).rejects.toThrow('đã gửi yêu cầu');
    expect((await OrderModel.findById(order._id).lean())?.total).toBe(281000);
  });

  it.each([OrderStatus.SHIPPED, OrderStatus.DELIVERED])('accepted after the parcel left the shop (%s)', async (status) => {
    const order = await seedOrder(status);
    const res = await build().orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    expect(res.einvoiceRequest?.status).toBe(EInvoiceRequestStatus.PENDING);
    expect(res.total).toBe(281000);
  });

  it('refused once the order is cancelled', async () => {
    const order = await seedOrder(OrderStatus.CANCELLED);
    await expect(build().orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY)).rejects.toThrow('đã hủy');
    expect((await OrderModel.findById(order._id).lean())?.einvoiceRequest).toBeUndefined();
  });

  it('refused for marketplace orders and for other users', async () => {
    const svc = build();
    const shopee = await seedOrder(OrderStatus.PENDING, { externalRef: { channel: 'SHOPEE', code: 'X1' } });
    await expect(svc.orders.requestEInvoiceByUser(shopee._id.toString(), userId, COMPANY)).rejects.toThrow('sàn');
    const order = await seedOrder(OrderStatus.PENDING);
    await expect(
      svc.orders.requestEInvoiceByUser(order._id.toString(), new Types.ObjectId().toString(), COMPANY),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('Shop decision', () => {
  it('reject records the reason and leaves the total as is', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PENDING);
    await svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    const res = await svc.orders.rejectEInvoiceRequest(order._id.toString(), staffId, 'MST không tồn tại');
    expect(res.total).toBe(281000);
    expect(res.vatAmount).toBe(0);
    expect(res.einvoiceRequest).toMatchObject({ status: EInvoiceRequestStatus.REJECTED, rejectReason: 'MST không tồn tại', decidedBy: staffId });
    await expect(svc.orders.approveEInvoiceRequest(order._id.toString(), staffId)).rejects.toThrow('đã được xử lý');
  });

  it('older request: reject takes the added VAT back out of the total', async () => {
    const order = await seedOrder(OrderStatus.PENDING, LEGACY);
    const res = await build().orders.rejectEInvoiceRequest(order._id.toString(), staffId, 'Sai MST');
    expect(res.total).toBe(281000);
    expect(res.vatAmount).toBe(0);
  });

  it('a pending request does not hold up shipping', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PROCESSING);
    const id = order._id.toString();
    await svc.orders.requestEInvoiceByUser(id, userId, COMPANY);
    const shipped = await svc.orders.updateStatus(id, { status: OrderStatus.SHIPPED }, staffId, StaffRole.ADMIN);
    expect(shipped.status).toBe(OrderStatus.SHIPPED);
    expect(shipped.einvoiceRequest?.status).toBe(EInvoiceRequestStatus.PENDING);
  });

  it('older request: shipping is blocked while pending (COD includes the VAT), allowed after approval', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PROCESSING, LEGACY);
    const id = order._id.toString();
    await expect(svc.orders.updateStatus(id, { status: OrderStatus.SHIPPED }, staffId, StaffRole.ADMIN)).rejects.toThrow(
      'chưa xử lý',
    );
    const approved = await svc.orders.approveEInvoiceRequest(id, staffId);
    expect(approved.einvoiceRequest?.status).toBe(EInvoiceRequestStatus.APPROVED);
    expect(approved.total).toBe(306900);
    const shipped = await svc.orders.updateStatus(id, { status: OrderStatus.SHIPPED }, staffId, StaffRole.ADMIN);
    expect(shipped.status).toBe(OrderStatus.SHIPPED);
  });

  it('cannot approve a request on a cancelled order', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PENDING);
    await svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    await OrderModel.updateOne({ _id: order._id }, { status: OrderStatus.CANCELLED });
    await expect(svc.orders.approveEInvoiceRequest(order._id.toString(), staffId)).rejects.toThrow('đã bị hủy');
  });
});

describe('Invoice issued for an approved request', () => {
  async function approvedOrder(svc: ReturnType<typeof build>) {
    const order = await seedOrder(OrderStatus.PROCESSING);
    await svc.orders.requestEInvoiceByUser(order._id.toString(), userId, COMPANY);
    await svc.orders.approveEInvoiceRequest(order._id.toString(), staffId);
    return order._id.toString();
  }

  it('prefill matches what the customer pays', async () => {
    const svc = build();
    const id = await approvedOrder(svc);
    const prefill = await svc.einvoices.prefillFromOrderRequest(id);
    expect(prefill).toMatchObject({
      customerName: 'Công ty TNHH Ánh Sáng',
      buyerName: 'Nguyễn Văn A',
      customerTaxCode: '0312345678',
      customerEmail: 'ketoan@anhsang.vn',
      totalBeforeTax: 255455,
      vatAmount: 25545,
      totalAmount: 281000,
      orderTotal: 281000,
    });
    expect(prefill.items).toEqual([
      expect.objectContaining({ name: 'Đèn', quantity: 1, unitPrice: 235454, vatRate: 10 }),
      expect.objectContaining({ name: 'Phí vận chuyển', quantity: 1, unitPrice: 20001, vatRate: 10 }),
    ]);
  });

  it('older request (VAT on top): prefill keeps the order prices', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PROCESSING, LEGACY);
    const prefill = await svc.einvoices.prefillFromOrderRequest(order._id.toString());
    expect(prefill).toMatchObject({ totalBeforeTax: 281000, vatAmount: 28100, totalAmount: 309100, orderTotal: 306900 });
    expect(prefill.items[0]).toMatchObject({ unitPrice: 259000 });
  });

  it('issuing links the invoice, marks the request ISSUED and emails the PDF + key', async () => {
    const svc = build();
    const id = await approvedOrder(svc);
    const { orderId: _o, requestStatus: _s, totalBeforeTax: _b, vatAmount: _v, totalAmount: _t, orderTotal: _ot, paidAmount: _p, ...dto } =
      await svc.einvoices.prefillFromOrderRequest(id);
    const invoice = await svc.einvoices.create({ ...dto, orderId: id }, staffId);
    expect(invoice.totalAmount).toBe(281000);

    const order = await OrderModel.findById(id).lean();
    expect(order?.einvoiceRequest).toMatchObject({ status: EInvoiceRequestStatus.ISSUED });
    expect(order?.einvoiceRequest?.einvoiceId?.toString()).toBe(invoice._id.toString());
    expect(order?.einvoiceRequest?.invoiceUrl).toBe(`https://luxe-glow.vn/invoice/${invoice.accessToken}`);
    expect(order?.einvoiceRequest?.emailSentAt).toBeInstanceOf(Date);

    expect(mail.sendEInvoiceIssued).toHaveBeenCalledTimes(1);
    const [to, data] = mail.sendEInvoiceIssued.mock.calls[0];
    expect(to).toBe('ketoan@anhsang.vn');
    expect(data).toMatchObject({ invoiceNo: '00000077', totalAmount: 281000, viewUrl: order?.einvoiceRequest?.invoiceUrl });
    expect(data.securityCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(data.pdf.content.toString()).toContain('%PDF');
  });

  it('email failure is recorded (invoice still issued) and the admin can resend', async () => {
    const svc = build();
    const id = await approvedOrder(svc);
    mail.sendEInvoiceIssued.mockRejectedValueOnce(new Error('SMTP down'));
    const { orderId: _o, requestStatus: _s, totalBeforeTax: _b, vatAmount: _v, totalAmount: _t, orderTotal: _ot, paidAmount: _p, ...dto } =
      await svc.einvoices.prefillFromOrderRequest(id);
    await svc.einvoices.create({ ...dto, orderId: id }, staffId);
    expect((await OrderModel.findById(id).lean())?.einvoiceRequest).toMatchObject({
      status: EInvoiceRequestStatus.ISSUED,
      emailError: 'SMTP down',
    });

    await expect(svc.einvoices.resendRequestEmail(id, staffId)).resolves.toEqual({ sent: true });
    const after = (await OrderModel.findById(id).lean())?.einvoiceRequest;
    expect(after?.emailError).toBeUndefined();
    expect(after?.emailSentAt).toBeInstanceOf(Date);
  });

  it('an invoice for an order whose request is still pending is not linked', async () => {
    const svc = build();
    const order = await seedOrder(OrderStatus.PENDING);
    const id = order._id.toString();
    await svc.orders.requestEInvoiceByUser(id, userId, COMPANY);
    const { orderId: _o, requestStatus: _s, totalBeforeTax: _b, vatAmount: _v, totalAmount: _t, orderTotal: _ot, paidAmount: _p, ...dto } =
      await svc.einvoices.prefillFromOrderRequest(id);
    await svc.einvoices.create({ ...dto, orderId: id }, staffId);
    expect((await OrderModel.findById(id).lean())?.einvoiceRequest?.status).toBe(EInvoiceRequestStatus.PENDING);
    expect(mail.sendEInvoiceIssued).not.toHaveBeenCalled();
  });
});
