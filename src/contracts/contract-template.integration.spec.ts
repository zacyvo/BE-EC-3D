import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Contract,
  ContractDocument,
  ContractSchema,
  ContractStatus,
  ContractTemplate,
} from './schemas/contract.schema';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto/contract.dto';

/**
 * Chọn mẫu văn bản (template) khi tạo / sửa hợp đồng, over a real (in-memory) MongoDB.
 * Sản phẩm, Cloudinary và pdfmake được mock — chỉ kiểm dữ liệu lưu và input truyền sang PDF.
 */
jest.setTimeout(60_000);

const staffId = new Types.ObjectId().toString();
const productId = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let ContractModel: Model<ContractDocument>;

function build() {
  const products = [{ _id: new Types.ObjectId(productId), name: 'Móc khóa JOYLOVE', costPrice: 10_000, finalPrice: 25_000 }];
  const productModel = {
    find: jest.fn(() => ({ select: () => ({ lean: () => ({ exec: async () => products }) }) })),
  };
  const users = {
    findOrCreateByPhone: jest.fn(async (phone: string, name: string) => ({
      user: { _id: new Types.ObjectId(), email: `guest_${phone}@guest.luxe-glow.vn`, name },
      created: true,
    })),
  };
  const pdf = { generateContractPdf: jest.fn(async () => Buffer.from('%PDF-1.7')) };
  const storage = {
    uploadPdf: jest.fn(async (_buf: Buffer, publicId: string) => ({ url: `https://cdn/${publicId}`, publicId })),
  };
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  const service = new ContractsService(
    ContractModel,
    productModel as never,
    {} as never,
    users as never,
    {} as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    config,
    pdf as never,
    storage as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // PadesSignService
    {} as never, // SignaturePlacementService
    {} as never, // SigningCredentialsService
  );
  return { service, pdf };
}

function dto(patch: Partial<CreateContractDto> = {}): CreateContractDto {
  return {
    userPhone: '0912345678',
    customerName: 'Nguyễn Văn A',
    items: [{ productId, quantity: 10 }],
    ...patch,
  } as CreateContractDto;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  ContractModel = conn.model(Contract.name, ContractSchema) as unknown as Model<ContractDocument>;
  await ContractModel.init();
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

describe('create — chọn template', () => {
  it('không truyền template → DEFAULT, lịch 2 lần 50/50, không prefill địa điểm giao', async () => {
    const { service } = build();
    const res = await service.create(dto(), staffId);

    expect(res.template).toBe(ContractTemplate.DEFAULT);
    expect(res.paymentSchedule.map((i: { percent: number }) => i.percent)).toEqual([50, 50]);
    expect(res.paymentSchedule[0].timing).toContain('đề nghị thanh toán tạm ứng từ Bên B');
    expect(res.deliveryAddress).toBe('');
  });

  it('JOYLOVE_ADVANCE → lịch mặc định 2 đợt 60/40 và prefill kho Flash', async () => {
    const { service } = build();
    const res = await service.create(dto({ template: ContractTemplate.JOYLOVE_ADVANCE }), staffId);

    expect(res.template).toBe(ContractTemplate.JOYLOVE_ADVANCE);
    expect(res.paymentSchedule.map((i: { percent: number }) => i.percent)).toEqual([60, 40]);
    expect(res.deliveryAddress).toContain('Kho Flash');
  });

  it('số đợt thanh toán phải khớp template', async () => {
    const { service } = build();
    const threeInstallments = [
      { percent: 50, timing: 'a' },
      { percent: 40, timing: 'b' },
      { percent: 10, timing: 'c' },
    ];

    await expect(
      service.create(dto({ template: ContractTemplate.JOYLOVE_ADVANCE, paymentSchedule: threeInstallments }), staffId),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(dto({ paymentSchedule: [{ percent: 100, timing: 'ngay' }] }), staffId),
    ).rejects.toThrow('đúng 2 đợt');
    // Lịch 3 đợt cũ không còn dùng để lập hợp đồng DEFAULT mới
    await expect(service.create(dto({ paymentSchedule: threeInstallments }), staffId)).rejects.toThrow('đúng 2 đợt');
    expect(await ContractModel.countDocuments()).toBe(0);
  });
});

describe('update — đổi template', () => {
  it('đổi template không kèm lịch → lịch reset về mặc định của template mới', async () => {
    const { service } = build();
    const created = await service.create(dto(), staffId);

    const res = await service.update(created._id.toString(), { template: ContractTemplate.JOYLOVE_ADVANCE }, staffId);

    expect(res.template).toBe(ContractTemplate.JOYLOVE_ADVANCE);
    expect(res.paymentSchedule.map((i: { percent: number }) => i.percent)).toEqual([60, 40]);
  });

  it('đổi template kèm lịch sai số đợt → từ chối', async () => {
    const { service } = build();
    const created = await service.create(dto(), staffId);

    await expect(
      service.update(
        created._id.toString(),
        {
          template: ContractTemplate.JOYLOVE_ADVANCE,
          paymentSchedule: [
            { percent: 50, timing: 'a' },
            { percent: 40, timing: 'b' },
            { percent: 10, timing: 'c' },
          ],
        },
        staffId,
      ),
    ).rejects.toThrow('đúng 2 đợt');
    expect((await ContractModel.findById(created._id))!.template).toBe(ContractTemplate.DEFAULT);
  });
});

describe('update — hợp đồng DEFAULT cũ lưu lịch 3 đợt', () => {
  const legacySchedule = [
    { percent: 50, timing: 'ngay khi ký hợp đồng' },
    { percent: 40, timing: 'khi nghiệm thu' },
    { percent: 10, timing: 'sau 05 ngày kể từ ngày nghiệm thu' },
  ];

  it('vẫn sửa được lịch 3 đợt đã lưu', async () => {
    const { service } = build();
    const created = await service.create(dto(), staffId);
    await ContractModel.updateOne({ _id: created._id }, { paymentSchedule: legacySchedule });

    const edited = [{ ...legacySchedule[0], percent: 40 }, { ...legacySchedule[1], percent: 50 }, legacySchedule[2]];
    const res = await service.update(created._id.toString(), { paymentSchedule: edited }, staffId);

    expect(res.paymentSchedule.map((i: { percent: number }) => i.percent)).toEqual([40, 50, 10]);
  });

  it('được chuyển sang lịch 2 lần mới; không được đổi sang số đợt khác', async () => {
    const { service } = build();
    const created = await service.create(dto(), staffId);
    await ContractModel.updateOne({ _id: created._id }, { paymentSchedule: legacySchedule });

    await expect(
      service.update(created._id.toString(), { paymentSchedule: [{ percent: 100, timing: 'ngay' }] }, staffId),
    ).rejects.toThrow('đúng 2 đợt');

    const res = await service.update(
      created._id.toString(),
      { paymentSchedule: [{ percent: 50, timing: 'a' }, { percent: 50, timing: 'b' }] },
      staffId,
    );
    expect(res.paymentSchedule).toHaveLength(2);
  });
});

describe('PDF chính tắc', () => {
  it('chốt FINAL truyền template + ngày lập sang bộ sinh PDF', async () => {
    const { service, pdf } = build();
    const created = await service.create(dto({ template: ContractTemplate.JOYLOVE_ADVANCE }), staffId);
    const id = created._id.toString();

    await service.changeStatus(id, { status: ContractStatus.REVIEW }, staffId);
    await service.changeStatus(id, { status: ContractStatus.FINAL }, staffId);

    expect(pdf.generateContractPdf).toHaveBeenCalledTimes(1);
    const input = (pdf.generateContractPdf.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(input.template).toBe(ContractTemplate.JOYLOVE_ADVANCE);
    expect(input.createdAt).toBeInstanceOf(Date);
  });
});
