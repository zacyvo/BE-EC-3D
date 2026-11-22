import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AddendumStatus,
  Contract,
  ContractDocument,
  ContractSchema,
  ContractStatus,
  ContractTemplate,
  PartySignatureStatus,
} from './schemas/contract.schema';
import { ContractsService } from './contracts.service';
import { ContractAddendaService } from './contract-addenda.service';
import { SignCertSource, SignContractDto } from './dto/contract.dto';
import { PdfGenerationService } from '../document-signing/pdf-generation/pdf-generation.service';
import { PadesSignService } from '../document-signing/pades/pades-sign.service';
import { PadesVerifyService } from '../document-signing/pades/pades-verify.service';
import { SignaturePlacementService } from '../document-signing/pades/signature-placement.service';
import { SigningCredentialsService } from '../document-signing/pades/signing-credentials.service';
import { TamperCheckService } from '../document-signing/pades/tamper-check.service';
import { makeTestP12, useBundledFontsIfMissing } from '../document-signing/testing/test-pki';

/**
 * Phụ lục hợp đồng — MongoDB in-memory + sinh PDF / ký / xác thực PAdES THẬT, chỉ mock Cloudinary
 * (lưu file trong Map), danh mục sản phẩm và sổ doanh thu.
 * Chạy: NODE_OPTIONS=--experimental-vm-modules npx jest contract-addenda (pdfjs-dist là ESM-only).
 */
jest.setTimeout(120_000);

const staffId = new Types.ObjectId().toString();
const P12_PASSWORD = 'p12-secret';
const PRODUCT_ID = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let ContractModel: Model<ContractDocument>;
let p12: Buffer;

function build() {
  const files = new Map<string, Buffer>();
  const storage = {
    downloadPdf: jest.fn(async (url: string) => {
      const buf = files.get(url);
      if (!buf) throw new Error(`missing ${url}`);
      return buf;
    }),
    uploadPdf: jest.fn(async (buf: Buffer, publicId: string) => {
      files.set(`mem://${publicId}`, buf);
      return { url: `mem://${publicId}`, publicId };
    }),
    uploadSignatureImage: jest.fn(async (_buf: Buffer, publicId: string) => `mem://${publicId}.png`),
  };
  const products = [{ _id: new Types.ObjectId(PRODUCT_ID), name: 'Móc khoá 3D', costPrice: 20_000, finalPrice: 50_000 }];
  const productModel = {
    find: jest.fn(() => ({ select: () => ({ lean: () => ({ exec: async () => products }) }) })),
  };
  const revenueModel = { create: jest.fn(async (doc: object) => ({ _id: new Types.ObjectId(), ...doc })) };
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  const staff = { verifyPassword: jest.fn(async () => true) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const pdf = new PdfGenerationService();
  const verify = new PadesVerifyService();
  const tamper = new TamperCheckService();
  const sign = new PadesSignService();
  const placement = new SignaturePlacementService();
  const credentials = new SigningCredentialsService(config);

  const contracts = new ContractsService(
    ContractModel,
    productModel as never,
    revenueModel as never,
    {} as never,
    staff as never,
    audit as never,
    {} as never,
    config,
    pdf,
    storage as never,
    verify,
    tamper,
    {} as never,
    sign,
    placement,
    credentials,
  );
  const addenda = new ContractAddendaService(
    ContractModel,
    productModel as never,
    contracts,
    staff as never,
    audit as never,
    pdf,
    storage as never,
    verify,
    tamper,
    sign,
    placement,
    credentials,
  );
  return { contracts, addenda, files, storage, revenueModel, audit };
}

async function seed(patch: Record<string, unknown> = {}) {
  return ContractModel.create({
    contractNo: `${Math.floor(Math.random() * 999999)}/HĐ-2026`,
    status: ContractStatus.FINAL,
    userId: new Types.ObjectId(),
    userPhone: '0912345678',
    accessToken: new Types.ObjectId().toString(),
    securityCode: 'ABCDEFGH',
    createdBy: new Types.ObjectId(staffId),
    items: [{ productId: PRODUCT_ID, productCode: 'ABC123', productName: 'Đèn 3D', quantity: 2, unitPrice: 500_000, subtotal: 1_000_000, costPrice: 200_000 }],
    totalAmount: 1_000_000,
    partyA: { name: 'Nguyễn Văn A', representative: 'Nguyễn Văn A', phone: '0912345678' },
    partyB: { name: 'Luxe Glow', representative: 'Quách Phương Thanh Trúc' },
    signPlace: 'TP. Hồ Chí Minh',
    signDate: new Date('2026-11-01'),
    bankAccountNumber: '680446431',
    bankName: 'VPBANK',
    bankAccountHolder: 'HO KINH DOANH LUXE GLOW',
    partyBSignature: { status: PartySignatureStatus.VERIFIED },
    ...patch,
  });
}

const addendumDto = {
  title: 'Bổ sung móc khoá + gia công khắc tên',
  items: [
    { productId: PRODUCT_ID, quantity: 4 }, // 4 × 50.000 = 200.000, giá vốn 20.000
    { productName: 'Gia công khắc tên', productCode: 'GC01', quantity: 4, unitPrice: 25_000, costPrice: 5_000 }, // 100.000
  ],
};

const signDto = { certSource: SignCertSource.UPLOAD, certPassword: P12_PASSWORD } as SignContractDto;

async function reload(id: Types.ObjectId) {
  return (await ContractModel.findById(id).exec())!;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  ContractModel = conn.model(Contract.name, ContractSchema) as unknown as Model<ContractDocument>;
  await ContractModel.init();
  useBundledFontsIfMissing();
  p12 = makeTestP12('QUÁCH PHƯƠNG THANH TRÚC', P12_PASSWORD);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await ContractModel.deleteMany({});
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('soạn phụ lục', () => {
  it('chỉ lập phụ lục cho hợp đồng FINAL', async () => {
    const { addenda } = build();
    for (const status of [ContractStatus.DRAFT, ContractStatus.SUCCESS, ContractStatus.CLOSED]) {
      const c = await seed({ status });
      await expect(addenda.create(c._id.toString(), addendumDto, staffId)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('tạo bản nháp: hạng mục danh mục + tự nhập, giá trị, số phụ lục, chưa cộng vào tổng', async () => {
    const { addenda } = build();
    const c = await seed();
    const res = await addenda.create(c._id.toString(), addendumDto, staffId);
    const a = res.addenda[0];
    expect(a.status).toBe(AddendumStatus.DRAFT);
    expect(a.addendumNo).toBe(1);
    expect(a.amount).toBe(300_000);
    expect(a.items.map((i: { productCode: string }) => i.productCode)).toEqual([PRODUCT_ID.slice(-6).toUpperCase(), 'GC01']);
    expect(a.paymentSchedule).toHaveLength(1);
    expect(res.addendaAmount).toBe(0);
    expect(res.grandTotalAmount).toBe(1_000_000);
  });

  it('JOYLOVE_ADVANCE đã có sẵn Phụ lục 01/02 → phụ lục đầu tiên là số 03', async () => {
    const { addenda } = build();
    const c = await seed({ template: ContractTemplate.JOYLOVE_ADVANCE });
    const res = await addenda.create(c._id.toString(), { content: 'Lùi ngày giao hàng 5 ngày' }, staffId);
    expect(res.addenda[0].addendumNo).toBe(3);
    expect(res.addenda[0].amount).toBe(0);
  });

  it('từ chối phụ lục rỗng, hạng mục tự nhập thiếu đơn giá, lịch thanh toán lệch 100%', async () => {
    const { addenda } = build();
    const id = (await seed())._id.toString();
    await expect(addenda.create(id, {}, staffId)).rejects.toThrow(/ít nhất 1 hạng mục/);
    await expect(addenda.create(id, { items: [{ productName: 'Gia công', quantity: 1 }] }, staffId)).rejects.toThrow(/đơn giá/);
    await expect(
      addenda.create(id, { ...addendumDto, paymentSchedule: [{ percent: 60, timing: 'ngay' }] }, staffId),
    ).rejects.toThrow(/100%/);
  });

  it('sửa / xoá chỉ khi còn bản nháp; số phụ lục không dùng lại', async () => {
    const { addenda } = build();
    const c = await seed();
    const id = c._id.toString();
    let res = await addenda.create(id, addendumDto, staffId);
    const aid = res.addenda[0]._id.toString();
    res = await addenda.update(id, aid, { items: [{ productName: 'In thêm logo', quantity: 2, unitPrice: 150_000 }] }, staffId);
    expect(res.addenda[0].amount).toBe(300_000);

    res = await addenda.create(id, { content: 'Đổi màu sản phẩm' }, staffId);
    expect(res.addenda[1].addendumNo).toBe(2);
    res = await addenda.remove(id, res.addenda[1]._id.toString(), staffId);
    expect(res.addenda).toHaveLength(1);
    res = await addenda.create(id, { content: 'Đổi màu sản phẩm' }, staffId);
    expect(res.addenda[1].addendumNo).toBe(2); // số lớn nhất hiện có + 1

    await addenda.finalize(id, aid, staffId);
    await expect(addenda.update(id, aid, { title: 'x' }, staffId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(addenda.remove(id, aid, staffId)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('chốt / hủy phụ lục', () => {
  it('chốt → FINAL, sinh PDF chính tắc (có tổng giá trị sau điều chỉnh), cộng vào tổng thanh toán', async () => {
    const { addenda, files } = build();
    const c = await seed();
    const id = c._id.toString();
    const created = await addenda.create(id, addendumDto, staffId);
    const res = await addenda.finalize(id, created.addenda[0]._id.toString(), staffId);
    const a = res.addenda[0];
    expect(a.status).toBe(AddendumStatus.FINAL);
    expect(a.finalizedAt).toBeDefined();
    expect(a.signDate).toBeDefined();
    expect(a.unsignedPdfUrl).toMatch(/addendum-01\/unsigned$/);
    expect(res.addendaAmount).toBe(300_000);
    expect(res.grandTotalAmount).toBe(1_300_000);

    const pdf = files.get(a.unsignedPdfUrl)!;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('hủy phụ lục đã chốt → không còn tính vào tổng, lưu lý do', async () => {
    const { addenda } = build();
    const c = await seed();
    const id = c._id.toString();
    const r1 = await addenda.create(id, addendumDto, staffId);
    await addenda.finalize(id, r1.addenda[0]._id.toString(), staffId);
    const r2 = await addenda.create(id, { items: [{ productName: 'Hộp quà', quantity: 1, unitPrice: 50_000 }] }, staffId);
    let res = await addenda.finalize(id, r2.addenda[1]._id.toString(), staffId);
    expect(res.addendaAmount).toBe(350_000);

    res = await addenda.cancel(id, r1.addenda[0]._id.toString(), { reason: 'Khách đổi ý' }, staffId);
    expect(res.addenda[0].status).toBe(AddendumStatus.CANCELLED);
    expect(res.addenda[0].cancelReason).toBe('Khách đổi ý');
    expect(res.addendaAmount).toBe(50_000);
    expect(res.grandTotalAmount).toBe(1_050_000);
  });

  it('bản xem trước của bản nháp là PDF dựng tại chỗ, không lưu', async () => {
    const { addenda, storage } = build();
    const c = await seed();
    const created = await addenda.create(c._id.toString(), addendumDto, staffId);
    const { buffer, filename } = await addenda.previewPdf(c._id.toString(), created.addenda[0]._id.toString());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(filename).toMatch(/^phu-luc-01-hop-dong-.*-xem-truoc\.pdf$/);
    expect(storage.uploadPdf).not.toHaveBeenCalled();
  });
});

describe('ký số phụ lục', () => {
  it('Bên B ký trên hệ thống → VERIFIED; Bên A ký đơn giản; xuất PDF đã ký', async () => {
    const { addenda, contracts, files } = build();
    const c = await seed();
    const id = c._id.toString();
    const created = await addenda.create(id, addendumDto, staffId);
    const aid = created.addenda[0]._id.toString();
    await addenda.finalize(id, aid, staffId);

    const res = await addenda.signPartyBInSystem(id, aid, signDto, p12, staffId);
    const b = res.addenda[0].partyBSignature;
    expect(b.status).toBe(PartySignatureStatus.VERIFIED);
    expect(b.signerCertCN).toBe('QUÁCH PHƯƠNG THANH TRÚC');
    expect(b.signedPdfUrl).toMatch(/addendum-01\/party-b-signed$/);

    const signed = await addenda.getSignedPdf(id, aid);
    expect(signed.buffer.equals(files.get(b.signedPdfUrl)!)).toBe(true);
    await expect(addenda.signPartyBInSystem(id, aid, signDto, p12, staffId)).rejects.toThrow(/không thể ghi đè/);

    const doc = await reload(c._id);
    jest.spyOn(contracts, 'resolvePublicAccess').mockResolvedValue(doc);
    const pub = await addenda.submitPartyASimpleSignature(
      doc.accessToken,
      'jwt',
      aid,
      { canvasImageBase64: 'data:image/png;base64,iVBORw0KGgo=', confirmedName: 'Nguyễn Văn A' },
      '1.2.3.4',
      'jest',
    );
    expect(pub.addenda[0].partyASignature.status).toBe(PartySignatureStatus.VERIFIED);
    expect(pub.addenda[0].partyASignature.mode).toBe('SIMPLE');
  });

  it('khách không thấy phụ lục bản nháp và không thấy giá vốn', async () => {
    const { addenda, contracts } = build();
    const c = await seed();
    const id = c._id.toString();
    const r1 = await addenda.create(id, addendumDto, staffId);
    await addenda.finalize(id, r1.addenda[0]._id.toString(), staffId);
    const r2 = await addenda.create(id, { content: 'Đang soạn' }, staffId);

    const view = contracts.toPublicView(await reload(c._id));
    expect(view.addenda).toHaveLength(1);
    expect(view.addenda[0].items[0]).not.toHaveProperty('costPrice');
    expect(view.grandTotalAmount).toBe(1_300_000);

    jest.spyOn(contracts, 'resolvePublicAccess').mockResolvedValue(await reload(c._id));
    await expect(addenda.getPublicView('t', 'jwt', r2.addenda[1]._id.toString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(addenda.getDocumentToSign('t', 'jwt', r1.addenda[0]._id.toString())).rejects.toThrow(/chưa được Bên B ký/);
  });
});

describe('hoàn tất hợp đồng có phụ lục', () => {
  it('chặn khi còn bản nháp hoặc phụ lục chưa có chữ ký Bên B; doanh thu gồm phụ lục', async () => {
    const { addenda, contracts, revenueModel } = build();
    const c = await seed();
    const id = c._id.toString();
    const r1 = await addenda.create(id, addendumDto, staffId);
    const aid = r1.addenda[0]._id.toString();

    await expect(contracts.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId)).rejects.toThrow(/bản nháp/);
    await addenda.finalize(id, aid, staffId);
    await expect(contracts.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId)).rejects.toThrow(/chưa được Bên B ký/);

    // Phụ lục bị hủy không chặn và không tính doanh thu
    const r2 = await addenda.create(id, { items: [{ productName: 'Hộp quà', quantity: 1, unitPrice: 90_000 }] }, staffId);
    await addenda.finalize(id, r2.addenda[1]._id.toString(), staffId);
    await addenda.cancel(id, r2.addenda[1]._id.toString(), { reason: 'Không làm nữa' }, staffId);

    await addenda.signPartyBInSystem(id, aid, signDto, p12, staffId);
    const res = await contracts.changeStatus(id, { status: ContractStatus.SUCCESS }, staffId);
    expect(res.status).toBe(ContractStatus.SUCCESS);
    expect(revenueModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        revenue: 1_300_000,
        // HĐ gốc 2 × 200.000 + phụ lục (4 × 20.000 + 4 × 5.000)
        cost: 400_000 + 100_000,
      }),
    );
    await expect(addenda.create(id, addendumDto, staffId)).rejects.toThrow(/đã hoàn tất/);
  });
});
