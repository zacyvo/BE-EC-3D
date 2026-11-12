import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

/**
 * Tầng HTTP của POST /admin/contracts/import — multipart `file` + `data` (JSON), và
 * POST /admin/contracts/:id/document/sign — multipart `certificate` + field. Service được mock.
 */
const STAFF_ID = '665f1c2b9a1e4b0012345678';

let app: INestApplication;
let baseUrl: string;
const service = {
  importContract: jest.fn(async () => ({ ok: true })),
  signPartyBInSystem: jest.fn(async () => ({ ok: true })),
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])], // endpoint ký số có ThrottlerGuard
    controllers: [AdminContractsController],
    providers: [{ provide: ContractsService, useValue: service }],
  })
    .overrideGuard(JwtStaffGuard)
    .useValue({
      canActivate: (ctx: any) => {
        ctx.switchToHttp().getRequest().user = { sub: STAFF_ID };
        return true;
      },
    })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
  );
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => app?.close());
beforeEach(() => {
  service.importContract.mockClear();
  service.signPartyBInSystem.mockClear();
});

const PDF = new Blob([Buffer.from('%PDF-1.7\n%%EOF')], { type: 'application/pdf' });
const VALID = { userPhone: '0912345678', customerName: 'Nguyễn Văn A', totalAmount: 1000000, offlineSigned: true };

async function post(form: FormData) {
  const res = await fetch(`${baseUrl}/admin/contracts/import`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

function form(data: unknown, file: Blob | null = PDF, name = 'hop-dong.pdf') {
  const f = new FormData();
  if (file) f.append('file', file, name);
  if (data !== undefined) f.append('data', typeof data === 'string' ? data : JSON.stringify(data));
  return f;
}

it('hợp lệ → gọi service với DTO đã transform + file + staff id', async () => {
  const res = await post(form({ ...VALID, partyA: { address: '1 Lê Lợi' } }));
  expect(res.status).toBe(201);
  expect(service.importContract).toHaveBeenCalledTimes(1);
  const [dto, file, staffId] = service.importContract.mock.calls[0] as unknown as [any, any, string];
  expect(dto).toMatchObject({ ...VALID, partyA: { address: '1 Lê Lợi' } });
  expect(dto.constructor.name).toBe('ImportContractDto');
  expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  expect(staffId).toBe(STAFF_ID);
});

it('thiếu file → 400', async () => {
  const res = await post(form(VALID, null));
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('Vui lòng chọn file PDF');
});

it('file không phải PDF → 400', async () => {
  const res = await post(form(VALID, new Blob(['x'], { type: 'image/png' }), 'a.png'));
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('Chỉ chấp nhận file PDF');
});

it('data không phải JSON → 400', async () => {
  const res = await post(form('{not json'));
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('Dữ liệu hợp đồng không hợp lệ');
});

it('validate DTO: SĐT sai, thiếu tên, field lạ', async () => {
  const res = await post(form({ ...VALID, userPhone: '123', customerName: '', hacker: 1 }));
  expect(res.status).toBe(400);
  const msg = JSON.stringify(res.body);
  expect(msg).toContain('Số điện thoại không hợp lệ');
  expect(msg).toContain('Vui lòng nhập tên khách hàng');
  expect(msg).toContain('hacker');
  expect(service.importContract).not.toHaveBeenCalled();
});

describe('POST /admin/contracts/:id/document/sign', () => {
  const CONTRACT_ID = '665f1c2b9a1e4b0087654321';
  const P12 = new Blob([Buffer.from([0x30, 0x82, 0x01, 0x00])], { type: 'application/x-pkcs12' });

  async function sign(fields: Record<string, string>, file: Blob | null = P12, name = 'chu-ky.p12') {
    const f = new FormData();
    if (file) f.append('certificate', file, name);
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    const res = await fetch(`${baseUrl}/admin/contracts/${CONTRACT_ID}/document/sign`, { method: 'POST', body: f });
    return { status: res.status, body: await res.json() };
  }

  it('UPLOAD: truyền file + DTO đã transform (visible "false" → false)', async () => {
    const res = await sign({ certSource: 'UPLOAD', certPassword: 'pw', visible: 'false' });
    expect(res.status).toBe(201);
    const [id, dto, buffer, staffId] = service.signPartyBInSystem.mock.calls[0] as unknown as [string, any, Buffer, string];
    expect(id).toBe(CONTRACT_ID);
    expect(dto).toMatchObject({ certSource: 'UPLOAD', certPassword: 'pw', visible: false });
    expect(dto.constructor.name).toBe('SignContractDto');
    expect(buffer.length).toBe(4);
    expect(staffId).toBe(STAFF_ID);
  });

  it('SERVER: không cần file, visible mặc định giữ undefined', async () => {
    const res = await sign({ certSource: 'SERVER', staffPassword: 'admin' }, null);
    expect(res.status).toBe(201);
    const [, dto, buffer] = service.signPartyBInSystem.mock.calls[0] as unknown as [string, any, Buffer | undefined];
    expect(dto).toMatchObject({ certSource: 'SERVER', staffPassword: 'admin' });
    expect(dto.visible).toBeUndefined();
    expect(buffer).toBeUndefined();
  });

  it('file không phải .p12/.pfx → 400', async () => {
    const res = await sign({ certSource: 'UPLOAD' }, new Blob(['x']), 'key.pem');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('.p12 hoặc .pfx');
    expect(service.signPartyBInSystem).not.toHaveBeenCalled();
  });

  it('certSource sai / field lạ → 400', async () => {
    const res = await sign({ certSource: 'USB', hacker: '1' });
    expect(res.status).toBe(400);
    const msg = JSON.stringify(res.body);
    expect(msg).toContain('Nguồn chứng thư số không hợp lệ');
    expect(msg).toContain('hacker');
  });
});
