import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Contract,
  ContractDocument,
  ContractSchema,
  ContractSource,
  ContractStatus,
  PartySignatureStatus,
} from './schemas/contract.schema';
import { ContractsService } from './contracts.service';
import {
  ExternalRevenue,
  ExternalRevenueDocument,
  ExternalRevenueSchema,
} from '../external-revenue/schemas/external-revenue.schema';
import { ImportContractDto } from './dto/contract.dto';
import { Staff, StaffSchema } from '../staff/schemas/staff.schema';

/**
 * Import hợp đồng từ file PDF over a real (in-memory) MongoDB. Cloudinary + pdfjs được mock
 * (pdfjs là ESM-only, không nạp được trong Jest CJS — PdfInspectService được kiểm riêng).
 */
jest.setTimeout(60_000);

const staffId = new Types.ObjectId().toString();
const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

let mongod: MongoMemoryServer;
let conn: Connection;
let ContractModel: Model<ContractDocument>;
let RevenueModel: Model<ExternalRevenueDocument>;

function build() {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const users = {
    findOrCreateByPhone: jest.fn(async (phone: string, name: string) => ({
      user: { _id: new Types.ObjectId(), email: `guest_${phone}@guest.luxe-glow.vn`, name },
      created: true,
    })),
  };
  let uploads = 0;
  const storage = {
    uploadPdf: jest.fn(async (_buf: Buffer, publicId: string) => ({
      url: `https://res.cloudinary.com/x/raw/upload/v${++uploads}/${publicId}`,
      publicId,
    })),
    deleteRaw: jest.fn(async () => undefined),
    downloadPdf: jest.fn(async () => PDF),
  };
  const inspect = {
    inspect: jest.fn(async () => ({ pageCount: 3, hasTextLayer: true, sha256: 'abc123' })),
  };
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  const service = new ContractsService(
    ContractModel,
    {} as never, // productModel — HĐ import không dùng sản phẩm
    RevenueModel,
    users as never,
    {} as never,
    audit as never,
    {} as never,
    config,
    {} as never,
    storage as never,
    {} as never,
    {} as never,
    inspect as never,
  );
  return { service, storage, inspect, audit };
}

function dto(patch: Partial<ImportContractDto> = {}): ImportContractDto {
  return {
    userPhone: '0912345678',
    customerName: 'Nguyễn Văn A',
    title: 'Hợp đồng gia công mô hình',
    totalAmount: 15_000_000,
    costAmount: 6_000_000,
    ...patch,
  } as ImportContractDto;
}

const file = (name = 'hop-dong.pdf') => ({ buffer: PDF, originalname: name, size: PDF.length });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  ContractModel = conn.model(Contract.name, ContractSchema) as unknown as Model<ContractDocument>;
  RevenueModel = conn.model(ExternalRevenue.name, ExternalRevenueSchema) as unknown as Model<ExternalRevenueDocument>;
  conn.model(Staff.name, StaffSchema); // findAll populate('createdBy')
  await Promise.all([ContractModel.init(), RevenueModel.init()]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([ContractModel.deleteMany({}), RevenueModel.deleteMany({})]);
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('importContract', () => {
  it('tạo hợp đồng IMPORTED ở DRAFT, file PDF làm bản chính tắc', async () => {
    const { service, storage } = build();
    // Tên file tiếng Việt như multer trả về (UTF-8 bytes đọc theo latin1)
    const latin1Name = Buffer.from('Hợp đồng ABC.pdf', 'utf8').toString('latin1');
    const res = await service.importContract(dto({ contractNo: '12/2026/HĐ-ABC' }), file(latin1Name), staffId);

    expect(res.status).toBe(ContractStatus.DRAFT);
    expect(res.source).toBe(ContractSource.IMPORTED);
    expect(res.contractNo).toBe('12/2026/HĐ-ABC');
    expect(res.items).toEqual([]);
    expect(res.totalAmount).toBe(15_000_000);
    expect(res.importedCostAmount).toBe(6_000_000);
    expect(res.partyA.name).toBe('Nguyễn Văn A');
    expect(res.partyA.phone).toBe('0912345678');
    expect(res.partyA.email).toBe(''); // email guest tạm không in vào Bên A
    expect(res.unsignedPdfUrl).toContain(`${res._id.toString()}/unsigned`);
    expect(res.importedDocument).toMatchObject({
      originalFileName: 'Hợp đồng ABC.pdf',
      pageCount: 3,
      sha256: 'abc123',
      uploadedBy: staffId,
    });
    expect(storage.uploadPdf).toHaveBeenCalledTimes(1);
    expect((res as any).securityCode).toBeUndefined();
  });

  it('tự sinh số HĐ khi để trống', async () => {
    const { service } = build();
    const res = await service.importContract(dto(), file(), staffId);
    expect(res.contractNo).toMatch(/^\d{6}\/HĐ-\d{4}$/);
  });

  it('từ chối số HĐ trùng (kể cả HĐ đã xoá mềm) trước khi upload file', async () => {
    const { service, storage } = build();
    const first = await service.importContract(dto({ contractNo: 'HD-01' }), file(), staffId);
    await ContractModel.updateOne({ _id: first._id }, { isDeleted: true });

    await expect(service.importContract(dto({ contractNo: 'HD-01' }), file(), staffId)).rejects.toThrow(
      'Số hợp đồng "HD-01" đã tồn tại',
    );
    expect(storage.uploadPdf).toHaveBeenCalledTimes(1);
  });

  it('file PDF lỗi → không tạo hợp đồng, không upload', async () => {
    const { service, storage, inspect } = build();
    inspect.inspect.mockRejectedValueOnce(new BadRequestException('File PDF bị lỗi hoặc không đọc được'));
    await expect(service.importContract(dto(), file(), staffId)).rejects.toThrow('File PDF bị lỗi');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(await ContractModel.countDocuments({})).toBe(0);
  });
});

describe('vòng đời hợp đồng import', () => {
  it('DRAFT → FINAL không cần họ tên đầy đủ Bên A; không đi qua NEW/REVIEW', async () => {
    const { service } = build();
    const c = await service.importContract(dto({ customerName: 'Công ty X' }), file(), staffId);
    const id = c._id.toString();

    await expect(service.changeStatus(id, { status: ContractStatus.REVIEW }, staffId)).rejects.toThrow(
      'Không thể chuyển trạng thái',
    );
    const final = await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);
    expect(final.status).toBe(ContractStatus.FINAL);
    expect(final.finalizedAt).toBeDefined();
    expect(final.unsignedPdfUrl).toBe(c.unsignedPdfUrl); // không sinh lại PDF từ template
  });

  it('SUCCESS cần chữ ký số Bên B hoặc xác nhận đã ký ngoài hệ thống; giá vốn lấy từ importedCostAmount', async () => {
    const { service } = build();
    const c = await service.importContract(dto(), file(), staffId);
    const id = c._id.toString();
    await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);

    await expect(service.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId)).rejects.toThrow(
      'Đã ký ngoài hệ thống',
    );

    // FINAL: chỉ sửa được ghi chú + offlineSigned
    await expect(service.updateImported(id, { totalAmount: 1 }, staffId)).rejects.toThrow('chỉ còn sửa được');
    await service.updateImported(id, { offlineSigned: true, adminNote: 'Đã ký tay ngày 20/10' }, staffId);

    const done = await service.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId);
    expect(done.status).toBe(ContractStatus.SUCCESS);
    const revenue = await RevenueModel.findById(done.revenueEntryId).lean();
    expect(revenue).toMatchObject({ revenue: 15_000_000, cost: 6_000_000 });
  });

  it('SUCCESS được khi Bên B đã ký số hợp lệ (offlineSigned = false)', async () => {
    const { service } = build();
    const c = await service.importContract(dto(), file(), staffId);
    const id = c._id.toString();
    await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);
    await ContractModel.updateOne({ _id: id }, { 'partyBSignature.status': PartySignatureStatus.VERIFIED });
    const done = await service.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId);
    expect(done.status).toBe(ContractStatus.SUCCESS);
  });

  it('không ký Bên B khi còn DRAFT (file còn thay được)', async () => {
    const { service } = build();
    const c = await service.importContract(dto(), file(), staffId);
    await expect(service.uploadPartyBSigned(c._id.toString(), PDF, staffId)).rejects.toThrow(
      'chưa chốt bản chính thức',
    );
  });

  it('không dùng được API sửa template / tạo PDF template', async () => {
    const { service } = build();
    const c = await service.importContract(dto(), file(), staffId);
    const id = c._id.toString();
    await expect(service.update(id, { adminNote: 'x' }, staffId)).rejects.toThrow('không dùng template');
    await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);
    await expect(service.generateDocument(id, staffId)).rejects.toThrow('đã có sẵn file PDF');
  });
});

describe('updateImported / replaceImportedFile', () => {
  it('DRAFT: sửa số HĐ (check trùng), giá trị, Bên A', async () => {
    const { service } = build();
    await service.importContract(dto({ contractNo: 'HD-A' }), file(), staffId);
    const c = await service.importContract(dto({ contractNo: 'HD-B' }), file(), staffId);
    const id = c._id.toString();

    await expect(service.updateImported(id, { contractNo: 'HD-A' }, staffId)).rejects.toThrow('đã tồn tại');
    await expect(service.updateImported(id, { partyA: { name: '  ' } }, staffId)).rejects.toThrow(
      'Tên Bên A không được để trống',
    );

    const res = await service.updateImported(
      id,
      { contractNo: 'HD-B2', totalAmount: 20_000_000, partyA: { address: '1 Lê Lợi' } },
      staffId,
    );
    expect(res.contractNo).toBe('HD-B2');
    expect(res.totalAmount).toBe(20_000_000);
    expect(res.partyA).toMatchObject({ name: 'Nguyễn Văn A', address: '1 Lê Lợi' });
  });

  it('thay file khi DRAFT; chặn khi đã FINAL', async () => {
    const { service, inspect } = build();
    const c = await service.importContract(dto(), file(), staffId);
    const id = c._id.toString();

    inspect.inspect.mockResolvedValueOnce({ pageCount: 5, hasTextLayer: false, sha256: 'def456' });
    const replaced = await service.replaceImportedFile(id, file('ban-moi.pdf'), staffId);
    expect(replaced.unsignedPdfUrl).not.toBe(c.unsignedPdfUrl);
    expect(replaced.importedDocument).toMatchObject({
      originalFileName: 'ban-moi.pdf',
      pageCount: 5,
      hasTextLayer: false,
      sha256: 'def456',
    });

    await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);
    await expect(service.replaceImportedFile(id, file(), staffId)).rejects.toThrow('Bản nháp');
  });

  it('không áp dụng cho hợp đồng template', async () => {
    const { service } = build();
    const tpl = await ContractModel.create({
      contractNo: 'TPL-1',
      userId: new Types.ObjectId(),
      userPhone: '0912345678',
      accessToken: 'tok-tpl',
      securityCode: 'ABCDEFGH',
      items: [],
      createdBy: new Types.ObjectId(staffId),
    });
    expect(tpl.source).toBe(ContractSource.TEMPLATE);
    await expect(service.updateImported(tpl._id.toString(), { title: 'x' }, staffId)).rejects.toThrow(
      'Chỉ áp dụng cho hợp đồng import',
    );
  });

  it('xoá được HĐ import ở DRAFT, không xoá được khi FINAL', async () => {
    const { service } = build();
    const a = await service.importContract(dto(), file(), staffId);
    await service.remove(a._id.toString(), staffId);
    expect(await ContractModel.countDocuments({ isDeleted: false })).toBe(0);

    const b = await service.importContract(dto(), file(), staffId);
    await service.changeStatus(b._id.toString(), { status: ContractStatus.FINAL }, staffId);
    await expect(service.remove(b._id.toString(), staffId)).rejects.toThrow('Bản nháp hoặc Đã hủy');
  });
});

describe('findAll', () => {
  it('lọc theo nguồn và tìm theo tiêu đề', async () => {
    const { service } = build();
    await service.importContract(dto({ title: 'HĐ gia công đèn ngủ' }), file(), staffId);
    await ContractModel.create({
      contractNo: 'TPL-2',
      userId: new Types.ObjectId(),
      userPhone: '0912345678',
      accessToken: 'tok-tpl-2',
      securityCode: 'ABCDEFGH',
      items: [],
      createdBy: new Types.ObjectId(staffId),
    });

    const imported = await service.findAll({ page: 1, limit: 20, source: 'IMPORTED' });
    expect(imported.total).toBe(1);
    const template = await service.findAll({ page: 1, limit: 20, source: 'TEMPLATE' });
    expect(template.data.map((c) => c.contractNo)).toEqual(['TPL-2']);
    const byTitle = await service.findAll({ page: 1, limit: 20, search: 'đèn ngủ' });
    expect(byTitle.total).toBe(1);
  });
});
