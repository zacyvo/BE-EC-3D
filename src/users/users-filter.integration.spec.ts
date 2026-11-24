import { ValidationPipe } from '@nestjs/common';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User, UserDocument, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';
import { FindUsersQueryDto } from './dto/find-users-query.dto';

/** Admin customer list filters, from the raw query string (real ValidationPipe) to an in-memory MongoDB. */
jest.setTimeout(60_000);

let mongod: MongoMemoryServer;
let conn: Connection;
let UserModel: Model<UserDocument>;
let service: UsersService;

const pipe = new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true },
});
const parse = (query: Record<string, string>): Promise<FindUsersQueryDto> =>
  pipe.transform(query, { type: 'query', metatype: FindUsersQueryDto });

async function names(query: Record<string, string>) {
  const res = await service.findAll(await parse(query));
  expect(res.total).toBe(res.data.length);
  return res.data.map((u) => u.name).sort();
}

const ids: Record<string, Types.ObjectId> = {};
async function add(name: string, email: string, fields: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  ids[email] = _id;
  await UserModel.collection.insertOne({
    _id, name, email, provider: 'local', isDeleted: false, isBlocked: false, isGuest: false,
    createdAt: new Date('2026-05-10T05:00:00Z'), ...fields,
  } as never);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  UserModel = conn.model(User.name, UserSchema) as unknown as Model<UserDocument>;
  service = new UsersService(UserModel, {} as never, {} as never);

  await add('An', 'an@test.vn', { phone: '0912345678', marketingOptIn: true });
  await add('Bình', 'binh@gmail.com', { provider: 'google', isBlocked: true });
  await add('Chi', 'guest_0987654321@guest.luxe-glow.vn', { phone: '0987654321', isGuest: true });
  await add('Dũng', 'my.shopee_fan@test.vn', { createdAt: new Date('2026-06-01T00:00:00+07:00') });
  await add('Xóa', 'xoa@test.vn', { isDeleted: true });
  // Marketplace customers
  await add('Tên Thật', 'shopee_buyer1@guest.luxe-glow.vn', { isGuest: true });
  await add('****', 'guest_0900000001@guest.luxe-glow.vn', { isGuest: true });
  await add('N******n', 'shopee_buyer2@guest.luxe-glow.vn', { isGuest: true });

  await conn.collection('orders').insertMany([
    { userId: ids['an@test.vn'], status: 'DELIVERED', isDeleted: false },
    { userId: ids['an@test.vn'], status: 'PENDING', isDeleted: false },
    { userId: ids['binh@gmail.com'], status: 'PENDING', isDeleted: false },
    { userId: ids['my.shopee_fan@test.vn'], status: 'DELIVERED', isDeleted: true },
  ]);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

const REAL = ['An', 'Bình', 'Chi', 'Dũng'];
const MASKED = ['****', 'N******n', 'Tên Thật'];

describe('admin customer list filters', () => {
  it('masked: EXCLUDE drops shopee_ emails and masked names, ONLY keeps just those, absent keeps all', async () => {
    expect(await names({ masked: 'EXCLUDE' })).toEqual(REAL);
    expect(await names({ masked: 'ONLY' })).toEqual(MASKED);
    expect(await names({})).toEqual([...REAL, ...MASKED].sort());
    expect(await names({ masked: 'ALL' })).toEqual([...REAL, ...MASKED].sort());
  });

  it('search: name, email, phone (any spelling); special characters are literal', async () => {
    expect(await names({ search: 'bìn' })).toEqual(['Bình']);
    expect(await names({ search: 'GMAIL' })).toEqual(['Bình']);
    expect(await names({ search: '+84 912 345 678' })).toEqual(['An']);
    expect(await names({ search: '0912.345' })).toEqual(['An']);
    expect(await names({ search: '****' })).toEqual(['****', 'N******n']);
    expect(await names({ search: '(' })).toEqual([]);
    expect(await names({ search: 'shopee_', masked: 'EXCLUDE' })).toEqual(['Dũng']);
  });

  it('account type, provider, status', async () => {
    expect(await names({ accountType: 'REGISTERED' })).toEqual(['An', 'Bình', 'Dũng']);
    expect(await names({ accountType: 'GUEST', masked: 'EXCLUDE' })).toEqual(['Chi']);
    expect(await names({ provider: 'google' })).toEqual(['Bình']);
    expect(await names({ status: 'ACTIVE', masked: 'EXCLUDE' })).toEqual(['An', 'Chi', 'Dũng']);
    expect(await names({ status: 'BLOCKED' })).toEqual(['Bình']);
    expect(await names({ status: 'DELETED' })).toEqual(['Xóa']);
  });

  it('phone and marketing opt-in', async () => {
    expect(await names({ hasPhone: 'YES' })).toEqual(['An', 'Chi']);
    expect(await names({ hasPhone: 'NO', masked: 'EXCLUDE' })).toEqual(['Bình', 'Dũng']);
    expect(await names({ marketingOptIn: 'YES' })).toEqual(['An']);
    expect(await names({ marketingOptIn: 'NO', masked: 'EXCLUDE' })).toEqual(['Bình', 'Chi', 'Dũng']);
  });

  it('orders: any / delivered / none, deleted orders ignored', async () => {
    expect(await names({ orders: 'HAS_ORDER' })).toEqual(['An', 'Bình']);
    expect(await names({ orders: 'DELIVERED' })).toEqual(['An']);
    expect(await names({ orders: 'NONE', masked: 'EXCLUDE' })).toEqual(['Chi', 'Dũng']);
  });

  it('creation day range is inclusive, Vietnam time', async () => {
    expect(await names({ createdFrom: '2026-06-01' })).toEqual(['Dũng']);
    expect(await names({ createdTo: '2026-05-31', masked: 'EXCLUDE' })).toEqual(['An', 'Bình', 'Chi']);
    expect(await names({ createdFrom: '2026-05-10', createdTo: '2026-05-10', masked: 'EXCLUDE' })).toEqual(['An', 'Bình', 'Chi']);
  });

  it('paginates the filtered set', async () => {
    const res = await service.findAll(await parse({ page: '2', limit: '3', masked: 'EXCLUDE' }));
    expect(res).toMatchObject({ total: 4, page: 2, limit: 3 });
    expect(res.data).toHaveLength(1);
    expect(await parse({})).toMatchObject({ page: 1, limit: 20 });
  });

  it('rejects unknown values and impossible dates', async () => {
    for (const bad of [{ masked: 'x' }, { status: 'x' }, { provider: 'x' }, { createdFrom: '2026-02-31' }, { limit: '0' }, { limit: '1000' }]) {
      await expect(parse(bad as never)).rejects.toThrow();
    }
  });
});
