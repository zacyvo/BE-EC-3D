import { BadRequestException } from '@nestjs/common';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Banner, BannerDocument, BannerSchema } from './schemas/banner.schema';
import { Product, ProductDocument, ProductSchema } from '../products/schemas/product.schema';
import { Staff, StaffSchema } from '../staff/schemas/staff.schema';
import { BannersService, bannerStatus } from './banners.service';
import { BannerLinkType, BannerPlacement } from './banner.constants';
import { CreateBannerDto } from './dto/banner.dto';

/** Banner trang chủ trên MongoDB in-memory: lịch chạy, liên kết, thứ tự, fallback rỗng. */
jest.setTimeout(60_000);

const staffId = new Types.ObjectId().toString();
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/web-ec-3d/banners/a.jpg';
const HOUR = 3600_000;

let mongod: MongoMemoryServer;
let conn: Connection;
let BannerModel: Model<BannerDocument>;
let ProductModel: Model<ProductDocument>;
let service: BannersService;
const audit = { log: jest.fn().mockResolvedValue(undefined) };

function dto(extra: Partial<CreateBannerDto> = {}): CreateBannerDto {
  return {
    placement: BannerPlacement.HERO,
    title: 'Sale 11.11',
    imageDesktop: IMG,
    linkType: BannerLinkType.NONE,
    ...extra,
  } as CreateBannerDto;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  BannerModel = conn.model(Banner.name, BannerSchema) as unknown as Model<BannerDocument>;
  ProductModel = conn.model(Product.name, ProductSchema) as unknown as Model<ProductDocument>;
  conn.model(Staff.name, StaffSchema); // populate createdBy/updatedBy
  service = new BannersService(BannerModel, ProductModel, audit as never);
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await BannerModel.deleteMany({});
  await ProductModel.collection.deleteMany({});
});

describe('bannerStatus', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  it.each([
    [{ isActive: false, startAt: null, endAt: null }, 'INACTIVE'],
    [{ isActive: true, startAt: null, endAt: null }, 'RUNNING'],
    [{ isActive: true, startAt: new Date('2026-11-25T00:00:00Z'), endAt: null }, 'SCHEDULED'],
    [{ isActive: true, startAt: null, endAt: new Date('2026-11-24T10:00:00Z') }, 'EXPIRED'],
    [{ isActive: true, startAt: new Date('2026-11-24T09:00:00Z'), endAt: new Date('2026-11-24T11:00:00Z') }, 'RUNNING'],
  ])('%o → %s', (b, expected) => {
    expect(bannerStatus(b, now)).toBe(expected);
  });
});

describe('findPublic', () => {
  it('trả [] khi không có banner nào đang chạy (trang chủ dùng mặc định)', async () => {
    await service.create(dto({ isActive: false }), staffId);
    await service.create(dto({ startAt: new Date(Date.now() + HOUR) }), staffId);
    await service.create(dto({ startAt: new Date(Date.now() - 2 * HOUR), endAt: new Date(Date.now() - HOUR) }), staffId);
    expect(await service.findPublic(BannerPlacement.HERO)).toEqual([]);
  });

  it('chỉ trả banner trong khung thời gian, theo sortOrder, tách theo vị trí', async () => {
    const a = await service.create(dto({ title: 'A' }), staffId);
    const b = await service.create(dto({ title: 'B', endAt: new Date(Date.now() + HOUR) }), staffId);
    await service.create(dto({ title: 'Promo', placement: BannerPlacement.PROMO }), staffId);
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);

    const hero = await service.findPublic(BannerPlacement.HERO);
    expect(hero.map((x) => x.title)).toEqual(['A', 'B']);

    await service.reorder({ placement: BannerPlacement.HERO, ids: [b._id.toString(), a._id.toString()] }, staffId);
    expect((await service.findPublic(BannerPlacement.HERO)).map((x) => x.title)).toEqual(['B', 'A']);

    const all = await service.findPublic();
    expect(all.map((x) => x.placement).sort()).toEqual(['HERO', 'HERO', 'PROMO']);
  });

  it('banner tự bật/tắt theo giờ', async () => {
    const start = new Date('2026-12-01T00:00:00Z');
    const end = new Date('2026-12-02T00:00:00Z');
    await service.create(dto({ startAt: start, endAt: end }), staffId);
    expect(await service.findPublic(BannerPlacement.HERO, new Date('2026-11-30T23:59:59Z'))).toHaveLength(0);
    expect(await service.findPublic(BannerPlacement.HERO, new Date('2026-12-01T00:00:00Z'))).toHaveLength(1);
    expect(await service.findPublic(BannerPlacement.HERO, new Date('2026-12-02T00:00:00Z'))).toHaveLength(0);
  });

  it('liên kết sản phẩm dùng slug hiện tại; sản phẩm bị ẩn → /products', async () => {
    const product = await ProductModel.collection.insertOne({ name: 'Đèn', slug: 'den-ngu', isActive: true, isDeleted: false });
    await service.create(dto({ linkType: BannerLinkType.PRODUCT, productId: product.insertedId.toString() }), staffId);
    let [b] = await service.findPublic(BannerPlacement.HERO);
    expect(b).toMatchObject({ href: '/products/den-ngu', isExternal: false });

    await ProductModel.collection.updateOne({ _id: product.insertedId }, { $set: { slug: 'den-ngu-moi' } });
    [b] = await service.findPublic(BannerPlacement.HERO);
    expect(b.href).toBe('/products/den-ngu-moi');

    await ProductModel.collection.updateOne({ _id: product.insertedId }, { $set: { isActive: false } });
    [b] = await service.findPublic(BannerPlacement.HERO);
    expect(b.href).toBe('/products');
  });

  it('liên kết ngoài / trong / không liên kết', async () => {
    await service.create(dto({ title: 'Zalo', linkType: BannerLinkType.EXTERNAL, linkUrl: 'https://zalo.me/0909064680', openInNewTab: true }), staffId);
    await service.create(dto({ title: 'Custom', linkType: BannerLinkType.INTERNAL, linkUrl: '/custom-order' }), staffId);
    await service.create(dto({ title: 'None', linkType: BannerLinkType.NONE, openInNewTab: true }), staffId);
    const list = await service.findPublic(BannerPlacement.HERO);
    expect(list.find((x) => x.title === 'Zalo')).toMatchObject({ href: 'https://zalo.me/0909064680', isExternal: true, openInNewTab: true });
    expect(list.find((x) => x.title === 'Custom')).toMatchObject({ href: '/custom-order', isExternal: false });
    expect(list.find((x) => x.title === 'None')).toMatchObject({ href: null, openInNewTab: false });
    expect(list[0]).not.toHaveProperty('clickCount');
  });
});

describe('validation', () => {
  it.each([
    [{ linkType: BannerLinkType.INTERNAL, linkUrl: 'custom-order' }],
    [{ linkType: BannerLinkType.INTERNAL, linkUrl: '//evil.com' }],
    [{ linkType: BannerLinkType.EXTERNAL, linkUrl: 'javascript:alert(1)' }],
    [{ linkType: BannerLinkType.EXTERNAL, linkUrl: '' }],
    [{ linkType: BannerLinkType.PRODUCT, productId: new Types.ObjectId().toString() }],
    [{ startAt: new Date('2026-12-02'), endAt: new Date('2026-12-01') }],
  ])('từ chối %o', async (extra) => {
    await expect(service.create(dto(extra as Partial<CreateBannerDto>), staffId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update giữ liên kết cũ khi chỉ đổi lịch, và kiểm lịch với giá trị đã lưu', async () => {
    const b = await service.create(dto({ linkType: BannerLinkType.INTERNAL, linkUrl: '/guide', startAt: new Date('2026-12-01') }), staffId);
    const updated = await service.update(b._id.toString(), { endAt: new Date('2026-12-05') }, staffId);
    expect(updated.linkUrl).toBe('/guide');
    await expect(service.update(b._id.toString(), { endAt: new Date('2026-11-30') }, staffId)).rejects.toBeInstanceOf(BadRequestException);
    const cleared = await service.update(b._id.toString(), { startAt: null, endAt: null }, staffId);
    expect(cleared.startAt).toBeNull();
    expect(cleared.endAt).toBeNull();
  });

  it('reorder từ chối banner khác vị trí', async () => {
    const promo = await service.create(dto({ placement: BannerPlacement.PROMO }), staffId);
    await expect(
      service.reorder({ placement: BannerPlacement.HERO, ids: [promo._id.toString()] }, staffId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('admin list + click', () => {
  it('đếm banner đang chạy theo vị trí và lượt bấm', async () => {
    const a = await service.create(dto(), staffId);
    await service.create(dto({ isActive: false }), staffId);
    await service.trackClick(a._id.toString());
    await service.trackClick(a._id.toString());
    await service.trackClick('not-an-id');
    const res = await service.findAllAdmin();
    expect(res.runningCounts).toEqual({ HERO: 1, PROMO: 0 });
    expect(res.items.find((x) => String(x._id) === a._id.toString())).toMatchObject({ clickCount: 2, status: 'RUNNING' });
  });
});
