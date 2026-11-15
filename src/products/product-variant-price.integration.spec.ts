import { Logger } from '@nestjs/common';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Product, ProductDocument, ProductSchema } from './schemas/product.schema';
import { Category, CategoryDocument, CategorySchema } from '../categories/schemas/category.schema';
import { Order, OrderDocument, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { Cart, CartDocument, CartSchema } from '../cart/schemas/cart.schema';
import { ProductsService } from './products.service';
import { CartService } from '../cart/cart.service';
import { OrdersService } from '../orders/orders.service';
import { AuditService } from '../audit/audit.service';

/**
 * Giá theo phân loại over a real (in-memory) MongoDB: ProductsService stores/sanitizes
 * Product.variants, CartService and OrdersService charge the selected variant's price.
 */
jest.setTimeout(60_000);

const staffId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

let mongod: MongoMemoryServer;
let conn: Connection;
let ProductModel: Model<ProductDocument>;
let CategoryModel: Model<CategoryDocument>;
let OrderModel: Model<OrderDocument>;
let VersionModel: Model<OrderVersionDocument>;
let CartModel: Model<CartDocument>;

function build() {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn(), del: jest.fn() };
  const products = new ProductsService(ProductModel, CategoryModel, OrderModel, cache as never, audit);
  const cart = new CartService(CartModel, products);
  const users = { findById: jest.fn(async () => ({ _id: userId, name: 'Khách' })) };
  const orders = new OrdersService(
    OrderModel,
    VersionModel,
    products,
    cart,
    audit,
    {} as never,
    users as never,
    {} as never,
    { kick: jest.fn() } as never,
  );
  return { products, cart, orders };
}

async function seedProduct(svc: ReturnType<typeof build>) {
  const category = await CategoryModel.create({ name: 'Đèn', slug: `den-${Date.now()}` });
  return svc.products.create(
    {
      name: 'Đèn ngủ 3D',
      images: ['https://cdn.example/den.jpg'],
      category: category._id.toString(),
      colors: [{ name: 'Đỏ' }, { name: 'Xanh' }],
      sizes: ['20cm', '30cm'],
      costPrice: 0,
      sellingPrice: 100000,
      discountPercent: 10,
      stock: 50,
      variants: [
        { color: 'Đỏ', size: '20cm', sellingPrice: 100000 },
        { color: 'Đỏ', size: '30cm', sellingPrice: 150000 },
        { color: 'Xanh', size: '30cm', sellingPrice: 200000 },
        { color: 'Tím', size: '20cm', sellingPrice: 1 }, // not an option → dropped
      ],
    },
    staffId,
  );
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  // autoIndex off: CartSchema declares userId both unique and via .index() (pre-existing), which
  // makes index builds conflict here; these tests don't depend on indexes.
  conn = await mongoose.createConnection(mongod.getUri(), { autoIndex: false }).asPromise();
  ProductModel = conn.model(Product.name, ProductSchema) as unknown as Model<ProductDocument>;
  CategoryModel = conn.model(Category.name, CategorySchema) as unknown as Model<CategoryDocument>;
  OrderModel = conn.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
  VersionModel = conn.model(OrderVersion.name, OrderVersionSchema) as unknown as Model<OrderVersionDocument>;
  CartModel = conn.model(Cart.name, CartSchema) as unknown as Model<CartDocument>;
});

afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await Promise.all([ProductModel.deleteMany({}), OrderModel.deleteMany({}), CartModel.deleteMany({}), VersionModel.deleteMany({})]);
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('ProductsService — Product.variants', () => {
  it('stores only valid combinations with finalPrice after the product discount', async () => {
    const svc = build();
    const p = await seedProduct(svc);
    expect(p.variants.map((v) => ({ color: v.color, size: v.size, sellingPrice: v.sellingPrice, finalPrice: v.finalPrice }))).toEqual([
      { color: 'Đỏ', size: '20cm', sellingPrice: 100000, finalPrice: 90000 },
      { color: 'Đỏ', size: '30cm', sellingPrice: 150000, finalPrice: 135000 },
      { color: 'Xanh', size: '30cm', sellingPrice: 200000, finalPrice: 180000 },
    ]);
  });

  it('on update: recomputes finalPrice when only the discount changes, drops entries of a removed option', async () => {
    const svc = build();
    const p = await seedProduct(svc);
    const discounted = await svc.products.update(p._id.toString(), { discountPercent: 0 }, staffId);
    expect(discounted.variants.map((v) => v.finalPrice)).toEqual([100000, 150000, 200000]);

    const noRed = await svc.products.update(p._id.toString(), { colors: [{ name: 'Xanh' }] }, staffId);
    expect(noRed.variants).toHaveLength(1);
    expect(noRed.variants[0]).toMatchObject({ color: 'Xanh', size: '30cm', finalPrice: 200000 });
  });
});

describe('Cart + Order charge the selected variant price', () => {
  it('cart line price = variant price; unpriced combination falls back to the product price', async () => {
    const svc = build();
    const p = await seedProduct(svc);
    const id = p._id.toString();
    await svc.cart.addItem(userId, { productId: id, quantity: 1, color: 'Xanh', size: '30cm' });
    const cart = await svc.cart.addItem(userId, { productId: id, quantity: 1, color: 'Xanh', size: '20cm' });
    expect(cart.items.map((i) => [i.color, i.size, i.price])).toEqual([
      ['Xanh', '30cm', 180000],
      ['Xanh', '20cm', 90000], // no entry → product finalPrice
    ]);
  });

  it('admin-created order uses per-variant unit prices for subtotal/total', async () => {
    const svc = build();
    const p = await seedProduct(svc);
    const id = p._id.toString();
    const order = await svc.orders.createForAdmin(staffId, {
      userId,
      items: [
        { productId: id, quantity: 2, color: 'Đỏ', size: '30cm' },
        { productId: id, quantity: 1, color: 'Xanh', size: '30cm' },
      ],
      shippingInfo: { recipientName: 'A', phone: '0912345678', street: '1 Lê Lợi', ward: 'Bến Thành', city: 'TP.HCM' },
    } as never);
    expect(order.items.map((i) => [i.unitPrice, i.subtotal])).toEqual([
      [135000, 270000],
      [180000, 180000],
    ]);
    expect(order.subtotal).toBe(450000);
  });
});
