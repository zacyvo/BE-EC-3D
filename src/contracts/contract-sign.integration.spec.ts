import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Contract,
  ContractDocument,
  ContractSchema,
  ContractStatus,
  PartySignMethod,
  PartySignatureStatus,
} from './schemas/contract.schema';
import { ContractsService } from './contracts.service';
import { SignCertSource, SignContractDto } from './dto/contract.dto';
import { PdfGenerationService } from '../document-signing/pdf-generation/pdf-generation.service';
import { PadesSignService } from '../document-signing/pades/pades-sign.service';
import { PadesVerifyService } from '../document-signing/pades/pades-verify.service';
import { SignaturePlacementService } from '../document-signing/pades/signature-placement.service';
import { SigningCredentialsService } from '../document-signing/pades/signing-credentials.service';
import { TamperCheckService } from '../document-signing/pades/tamper-check.service';
import { makeTestP12, useBundledFontsIfMissing } from '../document-signing/testing/test-pki';

/**
 * Bên B ký số trực tiếp trên hệ thống — MongoDB in-memory + bộ ký / xác thực PAdES THẬT, chỉ mock
 * Cloudinary (lưu file trong Map) và StaffService.
 * Chạy: NODE_OPTIONS=--experimental-vm-modules npx jest contract-sign (pdfjs-dist là ESM-only).
 */
jest.setTimeout(120_000);

const staffId = new Types.ObjectId().toString();
const UNSIGNED_URL = 'mem://unsigned';
const P12_PASSWORD = 'p12-secret';

let mongod: MongoMemoryServer;
let conn: Connection;
let ContractModel: Model<ContractDocument>;
let unsignedPdf: Buffer;
let uploadP12: Buffer;
let serverP12: Buffer;

function build(opts: { serverP12?: Buffer; staffPasswordOk?: boolean } = {}) {
  const files = new Map<string, Buffer>([[UNSIGNED_URL, unsignedPdf]]);
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
  };
  const env: Record<string, string | undefined> = {
    CONTRACT_SIGNING_P12_BASE64: opts.serverP12?.toString('base64'),
    CONTRACT_SIGNING_P12_PASSWORD: P12_PASSWORD,
  };
  const config = { get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService;
  const staff = { verifyPassword: jest.fn(async () => opts.staffPasswordOk ?? true) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new ContractsService(
    ContractModel,
    {} as never,
    {} as never,
    {} as never,
    staff as never,
    audit as never,
    {} as never,
    config,
    {} as never,
    storage as never,
    new PadesVerifyService(),
    new TamperCheckService(),
    {} as never,
    new PadesSignService(),
    new SignaturePlacementService(),
    new SigningCredentialsService(config),
  );
  return { service, files, staff, audit };
}

async function seed(status = ContractStatus.FINAL) {
  return ContractModel.create({
    contractNo: `${Math.floor(Math.random() * 9999)}/HĐ-2026`,
    status,
    userId: new Types.ObjectId(),
    userPhone: '0912345678',
    accessToken: new Types.ObjectId().toString(),
    securityCode: 'ABCDEFGH',
    createdBy: new Types.ObjectId(staffId),
    unsignedPdfUrl: UNSIGNED_URL,
    signPlace: 'TP. Hồ Chí Minh',
  });
}

const uploadDto = (patch: Partial<SignContractDto> = {}): SignContractDto =>
  ({ certSource: SignCertSource.UPLOAD, certPassword: P12_PASSWORD, ...patch }) as SignContractDto;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  ContractModel = conn.model(Contract.name, ContractSchema) as unknown as Model<ContractDocument>;
  await ContractModel.init();

  useBundledFontsIfMissing();
  unsignedPdf = await new PdfGenerationService().generateContractPdf({
    template: 'DEFAULT',
    contractNo: '0001/HĐ-2026',
    items: [{ productCode: 'A1', productName: 'Đèn 3D', quantity: 1, unitPrice: 100_000, subtotal: 100_000 }],
    totalAmount: 100_000,
    partyA: { name: 'Nguyễn Văn A', representative: 'Nguyễn Văn A' },
    partyB: { name: 'Luxe Glow', representative: 'Quách Phương Thanh Trúc' },
    signPlace: 'TP. Hồ Chí Minh',
    technicalRequirements: '',
    paymentSchedule: [{ percent: 100, timing: 'ngay' }],
    bankAccountNumber: '1',
    bankName: 'VPBANK',
    bankAccountHolder: 'LUXE GLOW',
    deliveryAddress: 'Q1',
  } as never);
  uploadP12 = makeTestP12('QUÁCH PHƯƠNG THANH TRÚC', P12_PASSWORD);
  serverP12 = makeTestP12('HỘ KINH DOANH LUXE GLOW', P12_PASSWORD);
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

describe('signPartyBInSystem — chứng thư tải lên', () => {
  it('ký thành công → VERIFIED, lưu bản đã ký, ghi audit; xuất PDF đã ký trả đúng file', async () => {
    const { service, files, audit } = build();
    const c = await seed();

    const res = await service.signPartyBInSystem(c._id.toString(), uploadDto(), uploadP12, staffId);

    expect(res.partyBSignature).toMatchObject({
      status: PartySignatureStatus.VERIFIED,
      signMethod: PartySignMethod.SYSTEM_UPLOADED_CERT,
      signerCertCN: 'QUÁCH PHƯƠNG THANH TRÚC',
      uploadedBy: staffId,
    });
    const stored = files.get(res.partyBSignature.signedPdfUrl!)!;
    expect(stored.subarray(0, unsignedPdf.length).equals(unsignedPdf)).toBe(true);
    const [sig] = new PadesVerifyService().verify(stored);
    expect(sig.digestValid && sig.signatureValid && sig.coversToEndOfFile).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_PARTY_B_SIGNED_IN_SYSTEM' }),
    );

    const exported = await service.getSignedPdfBuffer(c._id.toString());
    expect(exported.buffer.equals(stored)).toBe(true);
    expect(exported.filename).toMatch(/da-ky-so\.pdf$/);
  });

  it('không cho ký đè khi đã có chữ ký Bên B hợp lệ', async () => {
    const { service } = build();
    const c = await seed();
    await service.signPartyBInSystem(c._id.toString(), uploadDto(), uploadP12, staffId);

    await expect(
      service.signPartyBInSystem(c._id.toString(), uploadDto(), uploadP12, staffId),
    ).rejects.toThrow('không thể ghi đè');
  });

  it('sai mật khẩu chứng thư → 400, hợp đồng vẫn chưa ký', async () => {
    const { service } = build();
    const c = await seed();

    await expect(
      service.signPartyBInSystem(c._id.toString(), uploadDto({ certPassword: 'sai' }), uploadP12, staffId),
    ).rejects.toThrow('Mật khẩu chứng thư số không đúng');
    expect((await ContractModel.findById(c._id))!.partyBSignature.status).toBe(PartySignatureStatus.PENDING);
  });

  it('thiếu file chứng thư → 400', async () => {
    const { service } = build();
    const c = await seed();
    await expect(service.signPartyBInSystem(c._id.toString(), uploadDto(), undefined, staffId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('chứng thư đã hết hạn → từ chối ký', async () => {
    const { service } = build();
    const c = await seed();
    const expired = makeTestP12('X', P12_PASSWORD, {
      notBefore: new Date('2020-01-01'),
      notAfter: new Date('2021-01-01'),
    });
    await expect(service.signPartyBInSystem(c._id.toString(), uploadDto(), expired, staffId)).rejects.toThrow(
      'đã hết hạn',
    );
  });

  it.each([ContractStatus.DRAFT, ContractStatus.CLOSED])('trạng thái %s → không cho ký', async (status) => {
    const { service } = build();
    const c = await seed(status);
    await expect(
      service.signPartyBInSystem(c._id.toString(), uploadDto(), uploadP12, staffId),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('signPartyBInSystem — chứng thư cấu hình trên server', () => {
  it('chưa cấu hình → báo lỗi, signing-config trả null', async () => {
    const { service } = build();
    const c = await seed();
    expect(service.getSigningConfig().serverCertificate).toBeNull();
    await expect(
      service.signPartyBInSystem(c._id.toString(), { certSource: SignCertSource.SERVER, staffPassword: 'x' } as SignContractDto, undefined, staffId),
    ).rejects.toThrow('chưa cấu hình chứng thư số');
  });

  it('sai mật khẩu tài khoản admin → 400 (không phải 401)', async () => {
    const { service } = build({ serverP12, staffPasswordOk: false });
    const c = await seed();
    await expect(
      service.signPartyBInSystem(c._id.toString(), { certSource: SignCertSource.SERVER, staffPassword: 'x' } as SignContractDto, undefined, staffId),
    ).rejects.toThrow('Mật khẩu tài khoản không đúng');
  });

  it('đúng mật khẩu → ký bằng chứng thư server', async () => {
    const { service, staff } = build({ serverP12 });
    const c = await seed();
    expect(service.getSigningConfig().serverCertificate).toMatchObject({
      subjectCN: 'HỘ KINH DOANH LUXE GLOW',
      currentlyValid: true,
    });

    const res = await service.signPartyBInSystem(
      c._id.toString(),
      { certSource: SignCertSource.SERVER, staffPassword: 'admin-pass', visible: false } as SignContractDto,
      undefined,
      staffId,
    );
    expect(staff.verifyPassword).toHaveBeenCalledWith(staffId, 'admin-pass');
    expect(res.partyBSignature).toMatchObject({
      status: PartySignatureStatus.VERIFIED,
      signMethod: PartySignMethod.SYSTEM_SERVER_CERT,
      signerCertCN: 'HỘ KINH DOANH LUXE GLOW',
    });
  });
});

describe('getSignedPdfBuffer', () => {
  it('chưa ký → 404', async () => {
    const { service } = build();
    const c = await seed();
    await expect(service.getSignedPdfBuffer(c._id.toString())).rejects.toThrow('chưa có bản PDF đã ký số');
  });
});
