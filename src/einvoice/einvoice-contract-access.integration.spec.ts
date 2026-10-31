import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  EInvoice,
  EInvoiceDocument,
  EInvoiceKind,
  EInvoiceLocalStatus,
  EInvoiceSchema,
} from './schemas/einvoice.schema';
import { EasyInvoiceClientService } from './easyinvoice-client.service';
import { EInvoiceService } from './einvoice.service';
import { ContractsService } from '../contracts/contracts.service';

/**
 * Khách xem hoá đơn điện tử liên kết trên trang hợp đồng (phiên của hợp đồng, không nhập khoá lại).
 * Chỉ hoá đơn Cơ quan Thuế đã phát hành/đã huỷ của ĐÚNG hợp đồng đó; EasyInvoice HTTP mocked.
 */
jest.setTimeout(60_000);

const contractId = new Types.ObjectId();
const otherContractId = new Types.ObjectId();
const CONTRACT_TOKEN = 'contract-token-1';

let mongod: MongoMemoryServer;
let conn: Connection;
let InvoiceModel: Model<EInvoiceDocument>;
let service: EInvoiceService;
let fetchMock: jest.SpyInstance;

/** Thay cho ContractsService.resolvePublicAccess — 'valid-jwt' là phiên hợp lệ của hợp đồng contractId */
const contractsService = {
  resolvePublicAccess: jest.fn(async (token: string, jwt?: string) => {
    if (token !== CONTRACT_TOKEN) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    if (jwt !== 'valid-jwt') throw new UnauthorizedException('Phiên không hợp lệ');
    return { _id: contractId };
  }),
};

let seq = 0;
function seedInvoice(overrides: Partial<EInvoice> = {}) {
  seq += 1;
  return InvoiceModel.create({
    invoiceKind: EInvoiceKind.TAX_AUTHORITY,
    ikey: `IKEY${seq}`,
    pattern: '1C26TLG',
    invoiceNo: String(seq).padStart(8, '0'),
    localStatus: EInvoiceLocalStatus.ISSUED,
    contractId,
    buyerName: 'Nguyễn Văn A',
    customerName: 'Công ty ABC',
    items: [{ name: 'Đèn', unit: 'Cái', quantity: 1, unitPrice: 100000, vatRate: 10, total: 100000, vatAmount: 10000, amount: 110000 }],
    totalBeforeTax: 100000,
    vatAmount: 10000,
    totalAmount: 110000,
    arisingDate: new Date(2026, 9, seq),
    accessToken: `inv-token-${seq}`,
    securityCode: 'SECRET88',
    sharedKeyFromContract: true,
    createdBy: new Types.ObjectId(),
    ...overrides,
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  InvoiceModel = conn.model(EInvoice.name, EInvoiceSchema) as unknown as Model<EInvoiceDocument>;
  const env: Record<string, string> = { EASYINVOICE_API_URL: 'http://ei.test' };
  const config = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
  service = new EInvoiceService(
    InvoiceModel,
    {} as never,
    {} as never,
    new EasyInvoiceClientService(config),
    {} as never,
    {} as never,
    {} as never,
    config,
    contractsService as unknown as ContractsService,
    {} as never,
  );
});

afterAll(async () => {
  await conn.close();
  await mongod.stop();
});

beforeEach(async () => {
  await InvoiceModel.deleteMany({ isDeleted: { $in: [true, false] } });
  fetchMock?.mockRestore();
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response('%PDF-1.4 mock', { headers: { 'content-type': 'application/pdf' } }),
  );
});

describe('Danh sách hoá đơn của hợp đồng', () => {
  it('mặc định chỉ trả hoá đơn Cơ quan Thuế đã phát hành của đúng hợp đồng', async () => {
    const issued = await seedInvoice();
    await seedInvoice({ localStatus: EInvoiceLocalStatus.CANCELLED, cancelReason: 'Sai MST' });
    await seedInvoice({ localStatus: EInvoiceLocalStatus.DRAFT, invoiceNo: undefined });
    await seedInvoice({ invoiceKind: EInvoiceKind.SALES });
    await seedInvoice({ contractId: otherContractId });
    await seedInvoice({ isDeleted: true });

    const list = await service.listForContract(CONTRACT_TOKEN, 'valid-jwt');

    expect(list.map((i) => i.token)).toEqual([issued.accessToken]);
  });

  it('hoá đơn đã huỷ / bản nháp được "Cho phép xem" -> hiển thị, mới nhất trước', async () => {
    const issued = await seedInvoice();
    const cancelled = await seedInvoice({
      localStatus: EInvoiceLocalStatus.CANCELLED,
      cancelReason: 'Sai MST',
      customerVisible: true,
    });
    const draft = await seedInvoice({ localStatus: EInvoiceLocalStatus.DRAFT, invoiceNo: undefined, customerVisible: true });
    await seedInvoice({ invoiceKind: EInvoiceKind.SALES, customerVisible: true });

    const list = await service.listForContract(CONTRACT_TOKEN, 'valid-jwt');

    expect(list.map((i) => i.token)).toEqual([draft.accessToken, cancelled.accessToken, issued.accessToken]);
    expect(list[1]).toMatchObject({ localStatus: 'CANCELLED', cancelReason: 'Sai MST', totalAmount: 110000 });
  });

  it('không lộ khoá bảo mật / ikey / id nội bộ', async () => {
    await seedInvoice();
    const [inv] = await service.listForContract(CONTRACT_TOKEN, 'valid-jwt');
    expect(inv).not.toHaveProperty('securityCode');
    expect(inv).not.toHaveProperty('ikey');
    expect(inv).not.toHaveProperty('_id');
    expect(inv).not.toHaveProperty('contractId');
  });

  it('hợp đồng chưa có hoá đơn -> mảng rỗng (frontend ẩn tab)', async () => {
    await seedInvoice({ contractId: otherContractId });
    expect(await service.listForContract(CONTRACT_TOKEN, 'valid-jwt')).toEqual([]);
  });

  it('phiên hợp đồng không hợp lệ -> 401', async () => {
    await seedInvoice();
    await expect(service.listForContract(CONTRACT_TOKEN, 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.listForContract(CONTRACT_TOKEN, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('Tải hoá đơn qua trang hợp đồng', () => {
  it('tải PDF hoá đơn của hợp đồng qua EasyInvoice', async () => {
    const inv = await seedInvoice();

    const file = await service.downloadForContract(CONTRACT_TOKEN, 'valid-jwt', inv.accessToken, 'pdf');

    expect(file.filename).toBe(`hoa-don-${inv.invoiceNo}.pdf`);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ Ikey: inv.ikey, Pattern: '1C26TLG', Option: 0 });
  });

  it('không tải được hoá đơn của hợp đồng khác / bản nháp, đã huỷ chưa được cho phép xem', async () => {
    const other = await seedInvoice({ contractId: otherContractId });
    const draft = await seedInvoice({ localStatus: EInvoiceLocalStatus.DRAFT });
    const cancelled = await seedInvoice({ localStatus: EInvoiceLocalStatus.CANCELLED });

    for (const token of [other.accessToken, draft.accessToken, cancelled.accessToken, 'khong-ton-tai']) {
      await expect(
        service.downloadForContract(CONTRACT_TOKEN, 'valid-jwt', token, 'pdf'),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
