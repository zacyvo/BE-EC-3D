import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EInvoice, EInvoiceDocument, EInvoiceKind, EInvoiceSchema } from './schemas/einvoice.schema';
import { Contract, ContractSchema } from '../contracts/schemas/contract.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { EasyInvoiceClientService } from './easyinvoice-client.service';
import { EInvoiceService } from './einvoice.service';
import { AuditService } from '../audit/audit.service';
import { CreateEInvoiceDto } from './dto/einvoice.dto';

/**
 * Bản nháp hoá đơn Cơ quan Thuế over a real (in-memory) MongoDB, EasyInvoice HTTP mocked:
 * tạo nháp (importInvoice) → sửa (import lại cùng ikey) → phát hành (issueInvoices) / xoá (removeUnsignedInvoice).
 */
jest.setTimeout(60_000);

const staffId = new Types.ObjectId().toString();
const env: Record<string, string> = {
  EASYINVOICE_API_URL: 'http://ei.test',
  EASYINVOICE_PATTERN: '1C26TLG',
  JWT_SECRET: 'test-secret',
  EASYINVOICE_SERIAL: '',
};

let mongod: MongoMemoryServer;
let conn: Connection;
let InvoiceModel: Model<EInvoiceDocument>;
let service: EInvoiceService;
let audit: { log: jest.Mock };
let fetchMock: jest.SpyInstance;
/** Phản hồi giả theo resource EasyInvoice — mỗi test tự cấu hình */
let handlers: Record<string, (body: any) => unknown>;

function ok(data: unknown) {
  return new Response(JSON.stringify({ Status: 2, Message: 'Ok', ErrorCode: '0', Data: data }), {
    headers: { 'content-type': 'application/json' },
  });
}

function fail(message: string) {
  return new Response(JSON.stringify({ Status: 4, Message: message, ErrorCode: '1' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function calls(resource: string): any[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith(resource))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

function draftDto(overrides: Partial<CreateEInvoiceDto> = {}): CreateEInvoiceDto {
  return {
    buyerName: 'Nguyễn Văn A',
    customerName: 'Công ty ABC',
    paymentMethod: 'Chuyển khoản',
    arisingDate: '2026-10-20',
    items: [{ name: 'Đèn in 3D', quantity: 2, unitPrice: 100000, vatRate: 10 }],
    saveAsDraft: true,
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  InvoiceModel = conn.model(EInvoice.name, EInvoiceSchema) as unknown as Model<EInvoiceDocument>;
  const ContractModel = conn.model(Contract.name, ContractSchema);
  const OrderModel = conn.model(Order.name, OrderSchema);
  const config = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
  audit = { log: jest.fn().mockResolvedValue(undefined) };
  service = new EInvoiceService(
    InvoiceModel,
    ContractModel as never,
    OrderModel as never,
    new EasyInvoiceClientService(config),
    {} as never,
    audit as unknown as AuditService,
    new JwtService(),
    config,
    {} as never,
  );
});

afterAll(async () => {
  await conn.close();
  await mongod.stop();
});

beforeEach(async () => {
  await InvoiceModel.deleteMany({ isDeleted: { $in: [true, false] } });
  audit.log.mockClear();
  handlers = {
    'api/publish/importInvoice': (b) => ({
      Pattern: b.Pattern,
      Invoices: [{ InvoiceStatus: 0, Pattern: b.Pattern, Ikey: /<Ikey>(.*?)<\/Ikey>/.exec(b.XmlData)?.[1] }],
    }),
    'api/publish/issueInvoices': (b) => ({
      Pattern: b.Pattern,
      KeyInvoiceNo: { [b.Ikeys[0]]: '00000123' },
      Invoices: [{ Ikey: b.Ikeys[0], InvoiceStatus: 1, No: '00000123', LookupCode: 'LK123', IssueDate: '28/10/2026' }],
    }),
    'api/business/removeUnsignedInvoice': () => ({}),
    'api/publish/getInvoicesByIkeys': () => ({ Invoices: [] }),
  };
  fetchMock?.mockRestore();
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const resource = String(url).replace('http://ei.test/', '');
    const handler = handlers[resource];
    if (!handler) throw new Error(`Unexpected EasyInvoice call: ${resource}`);
    const result = handler(JSON.parse((init as RequestInit).body as string));
    return result instanceof Response ? result : ok(result);
  });
});

describe('Tạo bản nháp', () => {
  it('gọi importInvoice (không phát hành), lưu DRAFT chưa có số', async () => {
    const res = await service.create(draftDto(), staffId);

    expect(calls('api/publish/importInvoice')).toHaveLength(1);
    expect(calls('api/publish/importAndIssueInvoice')).toHaveLength(0);
    expect(calls('api/publish/importInvoice')[0].XmlData).toContain('<Amount>220000</Amount>');
    expect(res.localStatus).toBe('DRAFT');
    expect(res.invoiceNo).toBeUndefined();
    expect(res.issueDate).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EINVOICE_DRAFT_CREATE' }));
  });

  it('từ chối lưu nháp với hoá đơn mua bán nội bộ', async () => {
    await expect(
      service.create(draftDto({ invoiceKind: EInvoiceKind.SALES }), staffId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Sửa bản nháp', () => {
  it('import lại cùng ikey và cập nhật nội dung', async () => {
    const draft = await service.create(draftDto(), staffId);
    const { saveAsDraft: _s, ...rest } = draftDto();

    const res = await service.updateDraft(
      draft._id.toString(),
      { ...rest, buyerName: 'Trần Thị B', items: [{ name: 'Đèn', quantity: 1, unitPrice: 500000, vatRate: 8 }] },
      staffId,
    );

    const imports = calls('api/publish/importInvoice');
    expect(imports).toHaveLength(2);
    expect(imports[1].XmlData).toContain(`<Ikey>${draft.ikey}</Ikey>`);
    expect(imports[1].XmlData).toContain('<Buyer>Trần Thị B</Buyer>');
    expect(res.totalAmount).toBe(540000);
    expect(res.localStatus).toBe('DRAFT');
  });

  it('không cho sửa hoá đơn đã phát hành', async () => {
    const draft = await service.create(draftDto(), staffId);
    await service.publishDraft(draft._id.toString(), {}, staffId);
    const { saveAsDraft: _s, ...rest } = draftDto();
    await expect(service.updateDraft(draft._id.toString(), rest, staffId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('Chuyển bản nháp thành chính thức', () => {
  it('gọi issueInvoices với ikey của bản nháp, ghi nhận số hoá đơn', async () => {
    const draft = await service.create(draftDto(), staffId);

    const res = await service.publishDraft(draft._id.toString(), {}, staffId);

    expect(calls('api/publish/issueInvoices')).toEqual([{ Ikeys: [draft.ikey], Pattern: '1C26TLG' }]);
    expect(res.localStatus).toBe('ISSUED');
    expect(res.invoiceNo).toBe('00000123');
    expect(res.lookupCode).toBe('LK123');
    expect(res.easyInvoiceStatus).toBe(1);
    expect(res.publishedBy?.toString()).toBe(staffId);
    expect(res.publishLockUntil).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EINVOICE_PUBLISH' }));
  });

  it('cập nhật ngày lập trên EasyInvoice trước khi phát hành nếu đổi ngày', async () => {
    const draft = await service.create(draftDto(), staffId);

    await service.publishDraft(draft._id.toString(), { arisingDate: '2026-10-28' }, staffId);

    const order = fetchMock.mock.calls.map((c) => String(c[0]).replace('http://ei.test/', ''));
    expect(order.slice(-2)).toEqual(['api/publish/importInvoice', 'api/publish/issueInvoices']);
    expect(calls('api/publish/importInvoice')[1].XmlData).toContain('<ArisingDate>28/10/2026</ArisingDate>');
    const saved = await InvoiceModel.findById(draft._id);
    expect(saved?.arisingDate.getDate()).toBe(28);
  });

  it('không import lại khi ngày lập không đổi', async () => {
    const draft = await service.create(draftDto(), staffId);
    await service.publishDraft(draft._id.toString(), { arisingDate: '2026-10-20' }, staffId);
    expect(calls('api/publish/importInvoice')).toHaveLength(1);
  });

  it('phát hành lỗi -> giữ DRAFT, nhả khoá để thử lại được', async () => {
    const draft = await service.create(draftDto(), staffId);
    handlers['api/publish/issueInvoices'] = () => fail('Chữ ký số hết hạn');

    await expect(service.publishDraft(draft._id.toString(), {}, staffId)).rejects.toThrow(/Chữ ký số hết hạn/);

    const saved = await InvoiceModel.findById(draft._id);
    expect(saved?.localStatus).toBe('DRAFT');
    expect(saved?.publishLockUntil).toBeUndefined();
    expect(saved?.errorMessage).toMatch(/Chữ ký số hết hạn/);

    handlers['api/publish/issueInvoices'] = (b) => ({ KeyInvoiceNo: { [b.Ikeys[0]]: '00000124' }, Invoices: [{ No: '00000124', InvoiceStatus: 1 }] });
    const res = await service.publishDraft(draft._id.toString(), {}, staffId);
    expect(res.invoiceNo).toBe('00000124');
    expect(res.errorMessage).toBe('');
  });

  it('lỗi kết nối nhưng EasyInvoice đã ký -> đối soát và ghi nhận ISSUED', async () => {
    const draft = await service.create(draftDto(), staffId);
    handlers['api/publish/issueInvoices'] = () => {
      throw new Error('socket hang up');
    };
    handlers['api/publish/getInvoicesByIkeys'] = () => ({
      Invoices: [{ Ikey: draft.ikey, No: '00000125', InvoiceStatus: 1, LookupCode: 'LK125' }],
    });

    const res = await service.publishDraft(draft._id.toString(), {}, staffId);

    expect(res.localStatus).toBe('ISSUED');
    expect(res.invoiceNo).toBe('00000125');
  });

  it('2 request phát hành đồng thời -> chỉ 1 request gọi EasyInvoice', async () => {
    const draft = await service.create(draftDto(), staffId);
    const id = draft._id.toString();

    const results = await Promise.allSettled([
      service.publishDraft(id, {}, staffId),
      service.publishDraft(id, {}, staffId),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(calls('api/publish/issueInvoices')).toHaveLength(1);
  });

  it('không phát hành lại hoá đơn đã phát hành', async () => {
    const draft = await service.create(draftDto(), staffId);
    await service.publishDraft(draft._id.toString(), {}, staffId);
    await expect(service.publishDraft(draft._id.toString(), {}, staffId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('Xoá bản nháp', () => {
  it('gọi removeUnsignedInvoice và xoá mềm', async () => {
    const draft = await service.create(draftDto(), staffId);

    await service.deleteDraft(draft._id.toString(), staffId);

    expect(calls('api/business/removeUnsignedInvoice')).toEqual([{ Ikey: draft.ikey, Pattern: '1C26TLG' }]);
    expect(await InvoiceModel.findById(draft._id)).toBeNull();
    expect(await InvoiceModel.findOne({ _id: draft._id, isDeleted: true })).not.toBeNull();
  });

  it('EasyInvoice báo lỗi và hoá đơn vẫn còn trên EasyInvoice -> không xoá local', async () => {
    const draft = await service.create(draftDto(), staffId);
    handlers['api/business/removeUnsignedInvoice'] = () => fail('Hoá đơn đã ký số');
    handlers['api/publish/getInvoicesByIkeys'] = () => ({ Invoices: [{ Ikey: draft.ikey, InvoiceStatus: 1 }] });

    await expect(service.deleteDraft(draft._id.toString(), staffId)).rejects.toThrow(/Hoá đơn đã ký số/);
    expect(await InvoiceModel.findById(draft._id)).not.toBeNull();
  });

  it('EasyInvoice không còn hoá đơn (đã xoá trên cổng) -> vẫn xoá local', async () => {
    const draft = await service.create(draftDto(), staffId);
    handlers['api/business/removeUnsignedInvoice'] = () => fail('Không tìm thấy hoá đơn');

    await service.deleteDraft(draft._id.toString(), staffId);
    expect(await InvoiceModel.findById(draft._id)).toBeNull();
  });
});

describe('Ràng buộc khác với bản nháp', () => {
  it('không huỷ được bản nháp (phải dùng xoá)', async () => {
    const draft = await service.create(draftDto(), staffId);
    await expect(service.cancel(draft._id.toString(), {}, staffId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('khách không truy cập được bản nháp qua link công khai', async () => {
    const draft = await service.create(draftDto(), staffId);
    await expect(service.getPublicMeta(draft.accessToken)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('đồng bộ trạng thái: bản nháp đã ký trên cổng EasyInvoice -> chuyển ISSUED', async () => {
    const draft = await service.create(draftDto(), staffId);
    handlers['api/publish/getInvoicesByIkeys'] = () => ({
      Invoices: [{ Ikey: draft.ikey, No: '00000126', InvoiceStatus: 1 }],
    });

    const res = await service.syncStatus(draft._id.toString(), staffId);

    expect(res.localStatus).toBe('ISSUED');
    expect(res.invoiceNo).toBe('00000126');
  });
});

describe('Cho phép khách xem hoá đơn chưa phát hành chính thức', () => {
  beforeEach(() => {
    handlers['api/publish/importAndIssueInvoice'] = (b) => ({
      Invoices: [{ No: '00000200', InvoiceStatus: 1, Pattern: b.Pattern }],
    });
  });

  it('bản nháp được "Cho phép xem" -> khách mở được qua link; ẩn lại -> không mở được', async () => {
    const draft = await service.create(draftDto(), staffId);
    const id = draft._id.toString();

    const shown = await service.setCustomerVisibility(id, true, staffId);
    expect(shown.customerVisible).toBe(true);
    await expect(service.getPublicMeta(draft.accessToken)).resolves.toMatchObject({ localStatus: 'DRAFT' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EINVOICE_CUSTOMER_VISIBILITY', afterData: { customerVisible: true } }),
    );

    await service.setCustomerVisibility(id, false, staffId);
    await expect(service.getPublicMeta(draft.accessToken)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('không áp dụng cho hoá đơn đã phát hành (luôn hiển thị) và hoá đơn mua bán', async () => {
    const issued = await service.create(draftDto({ saveAsDraft: false }), staffId);
    await expect(service.setCustomerVisibility(issued._id.toString(), true, staffId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.getPublicMeta(issued.accessToken)).resolves.toMatchObject({ localStatus: 'ISSUED' });

    const sales = await service.create(draftDto({ saveAsDraft: false, invoiceKind: EInvoiceKind.SALES }), staffId);
    await expect(service.setCustomerVisibility(sales._id.toString(), true, staffId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('quyền xem của bản nháp không mang sang khi phát hành rồi huỷ', async () => {
    const draft = await service.create(draftDto(), staffId);
    const id = draft._id.toString();
    await service.setCustomerVisibility(id, true, staffId);
    await service.publishDraft(id, {}, staffId);
    handlers['api/business/cancelInvoice'] = () => ({ Invoices: [{ InvoiceStatus: 3 }] });

    const cancelled = await service.cancel(id, { reason: 'Sai MST' }, staffId);

    expect(cancelled.customerVisible).toBe(false);
    await expect(service.getPublicMeta(draft.accessToken)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dữ liệu hiển thị cho khách khớp nội dung hoá đơn gửi EasyInvoice', async () => {
    let xml = '';
    handlers['api/publish/importAndIssueInvoice'] = (b) => {
      xml = b.XmlData;
      return { Invoices: [{ No: '00000200', InvoiceStatus: 1, Pattern: b.Pattern }] };
    };
    const issued = await service.create(
      draftDto({ saveAsDraft: false, customerAddress: '1 Lê Lợi, Q1', customerTaxCode: '0312345678' }),
      staffId,
    );
    const { accessJwt, invoice } = await service.verifyAccess(issued.accessToken, { securityCode: await codeOf(issued._id) });
    expect(accessJwt).toBeTruthy();

    const tag = (name: string) => new RegExp(`<${name}>(.*?)</${name}>`).exec(xml)?.[1];
    expect(invoice.buyerName).toBe(tag('Buyer'));
    expect(invoice.customerName).toBe(tag('CusName'));
    expect(invoice.customerTaxCode).toBe(tag('CusTaxCode'));
    expect(invoice.customerAddress).toBe(tag('CusAddress'));
    expect(invoice.paymentMethod).toBe(tag('PaymentMethod'));
    expect(invoice.amountInWords).toBe(tag('AmountInWords'));
    expect(String(invoice.totalAmount)).toBe(/<\/Products>[\s\S]*?<Amount>(.*?)<\/Amount>/.exec(xml)?.[1]);
    expect(invoice.items.map((i: { name: string }) => i.name)).toEqual([tag('ProdName')]);
  });
});

async function codeOf(id: unknown): Promise<string> {
  const doc = await InvoiceModel.findById(id).select('+securityCode').exec();
  return doc!.securityCode;
}
