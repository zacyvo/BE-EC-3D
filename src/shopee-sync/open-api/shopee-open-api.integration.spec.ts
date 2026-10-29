import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AuditService } from '../../audit/audit.service';
import { OrderStatus } from '../../orders/schemas/order.schema';
import { MarketplaceChannel, MarketplaceProduct, MarketplaceProductDocument, MarketplaceProductSchema } from '../schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantDocument, MarketplaceVariantSchema } from '../schemas/marketplace-variant.schema';
import { MarketplaceProductImage, MarketplaceProductImageDocument, MarketplaceProductImageSchema } from '../schemas/marketplace-product-image.schema';
import { ShopeeSyncItem, ShopeeSyncItemDocument, ShopeeSyncItemSchema } from '../schemas/shopee-sync-item.schema';
import { ShopeeSyncSession, ShopeeSyncSessionDocument, ShopeeSyncSessionSchema } from '../schemas/shopee-sync-session.schema';
import { ShopeeOrderSyncBatch, ShopeeOrderSyncBatchDocument, ShopeeOrderSyncBatchSchema } from '../schemas/shopee-order-sync-batch.schema';
import { ShopeeOrderSyncIssue, ShopeeOrderSyncIssueDocument, ShopeeOrderSyncIssueSchema } from '../schemas/shopee-order-sync-issue.schema';
import { ShopeeOpenApiCredential, ShopeeOpenApiCredentialDocument, ShopeeOpenApiCredentialSchema } from '../schemas/shopee-open-api-credential.schema';
import { ShopeeOpenApiAuthState, ShopeeOpenApiAuthStateDocument, ShopeeOpenApiAuthStateSchema } from '../schemas/shopee-open-api-auth-state.schema';
import { ShopeeSyncConfigService } from '../shopee-sync.config';
import { ShopeeSyncService } from '../shopee-sync.service';
import { ShopeeOrderSyncService } from '../shopee-order-sync.service';
import { ShopeeOpenApiConfigService } from './shopee-open-api.config';
import { ShopeeOpenApiClient } from './shopee-open-api.client';
import { SHOPEE_CREDENTIAL_KEY, ShopeeOpenApiAuthService } from './shopee-open-api-auth.service';
import { ShopeeOpenApiService } from './shopee-open-api.service';
import { ShopeeOpenApiProductSyncService } from './shopee-open-api-product-sync.service';
import { ShopeeOpenApiOrderSyncService } from './shopee-open-api-order-sync.service';
import { signShop } from './shopee-open-api.signer';

/**
 * End-to-end over a real (in-memory, replica-set → transactions work) MongoDB with Shopee's
 * HTTP API mocked at `fetch`: connect (OAuth callback) → token refresh rotation → product
 * full sync into the existing staging/preview/commit pipeline → order sync with escrow.
 */
jest.setTimeout(120_000);

const HOST = 'https://shopee-mock.test';
const PARTNER_ID = 2001234;
const PARTNER_KEY = 'partner-key-integration-0001';
const SHOP_ID = 76624421;
const ADMIN_ID = new Types.ObjectId().toString();

let rs: MongoMemoryReplSet;
let conn: Connection;
let models: {
  session: Model<ShopeeSyncSessionDocument>;
  item: Model<ShopeeSyncItemDocument>;
  product: Model<MarketplaceProductDocument>;
  variant: Model<MarketplaceVariantDocument>;
  image: Model<MarketplaceProductImageDocument>;
  batch: Model<ShopeeOrderSyncBatchDocument>;
  issue: Model<ShopeeOrderSyncIssueDocument>;
  cred: Model<ShopeeOpenApiCredentialDocument>;
  state: Model<ShopeeOpenApiAuthStateDocument>;
};
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
let shopeeHandler: (path: string, q: URLSearchParams, body: Record<string, unknown> | null) => unknown;
let tokenSeq = 0;

const ok = (response: unknown) => ({ error: '', message: '', request_id: 'req-1', response });

function build() {
  // Real ConfigService semantics: `get(key, default)` falls back to the default.
  const configService = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const syncConfig = new ShopeeSyncConfigService(configService);
  const apiConfig = new ShopeeOpenApiConfigService(configService);
  const client = new ShopeeOpenApiClient(apiConfig);
  const auth = new ShopeeOpenApiAuthService(models.cred, models.state, apiConfig, syncConfig, client, audit);
  const api = new ShopeeOpenApiService(client, auth, apiConfig);
  const publish = { publishProduct: jest.fn(async (p: { externalProductId: string }) => ({ action: 'created', externalProductId: p.externalProductId })) };
  const sync = new ShopeeSyncService(
    models.session, models.item, models.product, models.variant, models.image, conn, syncConfig, audit, publish as never,
  );
  const productSync = new ShopeeOpenApiProductSyncService(models.session, models.product, models.variant, sync, syncConfig, auth, api, audit);

  const catalogProductId = new Types.ObjectId();
  const products = {
    findAll: jest.fn(async () => ({
      data: [{ _id: catalogProductId, name: 'Tên đã đổi trên Luxe Glow', slug: 'loopy', images: ['https://img/1.jpg'], colors: [{ name: 'Cam', images: ['https://img/cam.jpg'] }], sizes: [] }],
    })),
  };
  const createdOrders: Record<string, unknown>[] = [];
  const orders = {
    findByExternalRef: jest.fn(async () => null),
    importExternalOrder: jest.fn(async (input: Record<string, unknown>) => {
      createdOrders.push(input);
      return { order: { _id: new Types.ObjectId() } };
    }),
  };
  const orderSync = new ShopeeOrderSyncService(models.batch, models.issue, models.product, orders as never, products as never, audit, syncConfig);
  const orderApiSync = new ShopeeOpenApiOrderSyncService(models.batch, models.cred, orderSync, syncConfig, apiConfig, auth, api);
  return { auth, sync, productSync, orderApiSync, publish, createdOrders, catalogProductId, audit };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function connectShop(svc: ReturnType<typeof build>) {
  const { url } = await svc.auth.createAuthUrl(ADMIN_ID);
  const redirect = new URL(new URL(url).searchParams.get('redirect')!);
  return svc.auth.handleCallback({ code: 'auth-code-1', shop_id: String(SHOP_ID), state: redirect.searchParams.get('state')! });
}

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '5.0.19' } });
  conn = await mongoose.createConnection(rs.getUri('shopee-open-api')).asPromise();
  models = {
    session: conn.model(ShopeeSyncSession.name, ShopeeSyncSessionSchema) as unknown as Model<ShopeeSyncSessionDocument>,
    item: conn.model(ShopeeSyncItem.name, ShopeeSyncItemSchema) as unknown as Model<ShopeeSyncItemDocument>,
    product: conn.model(MarketplaceProduct.name, MarketplaceProductSchema) as unknown as Model<MarketplaceProductDocument>,
    variant: conn.model(MarketplaceVariant.name, MarketplaceVariantSchema) as unknown as Model<MarketplaceVariantDocument>,
    image: conn.model(MarketplaceProductImage.name, MarketplaceProductImageSchema) as unknown as Model<MarketplaceProductImageDocument>,
    batch: conn.model(ShopeeOrderSyncBatch.name, ShopeeOrderSyncBatchSchema) as unknown as Model<ShopeeOrderSyncBatchDocument>,
    issue: conn.model(ShopeeOrderSyncIssue.name, ShopeeOrderSyncIssueSchema) as unknown as Model<ShopeeOrderSyncIssueDocument>,
    cred: conn.model(ShopeeOpenApiCredential.name, ShopeeOpenApiCredentialSchema) as unknown as Model<ShopeeOpenApiCredentialDocument>,
    state: conn.model(ShopeeOpenApiAuthState.name, ShopeeOpenApiAuthStateSchema) as unknown as Model<ShopeeOpenApiAuthStateDocument>,
  };
  await Promise.all((Object.values(models) as Model<unknown>[]).map((m) => m.createCollection()));
});

afterAll(async () => {
  await conn?.close();
  await rs?.stop();
});

beforeEach(async () => {
  await Promise.all((Object.values(models) as Model<unknown>[]).map((m) => m.deleteMany({})));
  tokenSeq = 0;
  env = {
    SHOPEE_PARTNER_ID: String(PARTNER_ID),
    SHOPEE_PARTNER_KEY: PARTNER_KEY,
    SHOPEE_API_HOST: HOST,
    SHOPEE_REDIRECT_URL: 'https://api.luxe.test/api/v1/integrations/shopee/open-api/callback',
    SHOPEE_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    SHOPEE_OPEN_API_REQUEST_DELAY_MS: '0',
    SHOPEE_SYNC_DEFAULT_SHOP_ID: 'luxe-glow-main',
    SHOPEE_SYNC_PUBLIC_SHOP_ID: String(SHOP_ID),
    ADMIN_URL: 'https://admin.luxe.test',
  };
  shopeeHandler = () => ({ error: 'error_not_found', message: 'unmocked' });
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (path === '/api/v2/auth/token/get' || path === '/api/v2/auth/access_token/get') {
      tokenSeq += 1;
      return new Response(JSON.stringify({ access_token: `access-${tokenSeq}`, refresh_token: `refresh-${tokenSeq}`, expire_in: 14400, error: '', message: '' }));
    }
    // Every shop call must carry a valid signature for its own access token.
    const q = url.searchParams;
    const expected = signShop(PARTNER_ID, path, Number(q.get('timestamp')), q.get('access_token')!, Number(q.get('shop_id')), PARTNER_KEY);
    if (q.get('sign') !== expected) return new Response(JSON.stringify({ error: 'error_sign', message: 'Wrong sign' }), { status: 403 });
    if (path === '/api/v2/shop/get_shop_info') {
      return new Response(JSON.stringify({ shop_name: 'Luxe Glow', region: 'VN', expire_time: 1793000000, error: '', message: '' }));
    }
    return new Response(JSON.stringify(shopeeHandler(path, q, body)));
  });
});

afterEach(() => fetchMock.mockRestore());

describe('connect (auth_partner callback)', () => {
  it('exchanges the code, stores encrypted tokens + shop info, and the state is single-use', async () => {
    const svc = build();
    const { url } = await svc.auth.createAuthUrl(ADMIN_ID);
    const state = new URL(new URL(url).searchParams.get('redirect')!).searchParams.get('state')!;

    const res = await svc.auth.handleCallback({ code: 'auth-code-1', shop_id: String(SHOP_ID), state });
    expect(res.redirectUrl).toBe('https://admin.luxe.test/integrations/shopee?shopee_auth=success');

    const doc = await models.cred.findOne({ key: SHOPEE_CREDENTIAL_KEY }).lean();
    expect(doc).toMatchObject({ status: 'ACTIVE', shopeeShopId: String(SHOP_ID), shopName: 'Luxe Glow', region: 'VN' });
    expect(doc!.accessTokenEnc).not.toContain('access-1');
    expect(doc!.refreshTokenEnc).not.toContain('refresh-1');
    const tokenCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/token/get'))!;
    expect(JSON.parse(String((tokenCall[1] as RequestInit).body))).toEqual({ code: 'auth-code-1', shop_id: SHOP_ID, partner_id: PARTNER_ID });

    const replay = await svc.auth.handleCallback({ code: 'auth-code-1', shop_id: String(SHOP_ID), state });
    expect(replay.redirectUrl).toContain('shopee_auth=error');
    expect((await svc.auth.statusView()).connected).toBe(true);
  });

  it('rejects a different shop than SHOPEE_SYNC_PUBLIC_SHOP_ID and a forged state', async () => {
    const svc = build();
    const { url } = await svc.auth.createAuthUrl(ADMIN_ID);
    const state = new URL(new URL(url).searchParams.get('redirect')!).searchParams.get('state')!;
    expect((await svc.auth.handleCallback({ code: 'c', shop_id: '111', state })).redirectUrl).toContain('shopee_auth=error');
    expect((await svc.auth.handleCallback({ code: 'c', shop_id: String(SHOP_ID), state: 'forged' })).redirectUrl).toContain('shopee_auth=error');
    expect(await models.cred.countDocuments()).toBe(0);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/token/get'))).toBe(false);
  });
});

describe('token lifecycle', () => {
  it('refreshes an expired access token once (rotating refresh token persisted) and retries a rejected one', async () => {
    const svc = build();
    await connectShop(svc);
    await models.cred.updateOne({ key: SHOPEE_CREDENTIAL_KEY }, { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });

    const [a, b] = await Promise.all([svc.auth.getAccessToken(), svc.auth.getAccessToken()]);
    expect(a).toMatchObject({ ok: true, accessToken: 'access-2' });
    expect(b).toMatchObject({ ok: true, accessToken: 'access-2' });
    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/auth/access_token/get'));
    expect(refreshCalls).toHaveLength(1);
    expect(JSON.parse(String((refreshCalls[0][1] as RequestInit).body)).refresh_token).toBe('refresh-1');

    // Shopee rejects access-2 once → service refreshes and the call succeeds with access-3.
    let rejected = false;
    shopeeHandler = (path, q) => {
      if (!rejected && q.get('access_token') === 'access-2') {
        rejected = true;
        return { error: 'error_auth', message: 'Invalid access_token.' };
      }
      return ok({ item: [], total_count: 0, has_next_page: false });
    };
    const api = new ShopeeOpenApiService(new ShopeeOpenApiClient(new ShopeeOpenApiConfigService({ get: (k: string, d?: unknown) => env[k] ?? d } as never)), svc.auth, new ShopeeOpenApiConfigService({ get: (k: string, d?: unknown) => env[k] ?? d } as never));
    await expect(api.getItemList({ offset: 0, pageSize: 100, itemStatus: ['NORMAL'] })).resolves.toMatchObject({ total_count: 0 });
    expect((await svc.auth.getAccessToken()) as { accessToken: string }).toMatchObject({ accessToken: 'access-3' });
  });

  it('a rejected refresh token flips the connection to REAUTH_REQUIRED', async () => {
    const svc = build();
    await connectShop(svc);
    await models.cred.updateOne({ key: SHOPEE_CREDENTIAL_KEY }, { $set: { accessTokenExpiresAt: new Date(0) } });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'error_param', message: 'Invalid refresh_token' })));
    expect(await svc.auth.getAccessToken()).toMatchObject({ ok: false, errorClass: 'REAUTH' });
    expect((await svc.auth.statusView()).status).toBe('REAUTH_REQUIRED');
    await expect(svc.productSync.startFullSync(ADMIN_ID, true, false)).rejects.toThrow(/kết nối lại/);
  });
});

describe('product sync via Open API', () => {
  const ITEMS = [101, 102, 103];

  function mockCatalog() {
    shopeeHandler = (path, q) => {
      switch (path) {
        case '/api/v2/product/get_item_list': {
          const offset = Number(q.get('offset'));
          expect(q.getAll('item_status')).toEqual(['NORMAL', 'UNLIST', 'REVIEWING', 'BANNED']);
          return offset === 0
            ? ok({ item: [{ item_id: 101, item_status: 'NORMAL', update_time: 1001 }, { item_id: 102, item_status: 'UNLIST', update_time: 1002 }], total_count: 3, has_next_page: true, next_offset: 2 })
            : ok({ item: [{ item_id: 103, item_status: 'NORMAL', update_time: 1003 }], total_count: 3, has_next_page: false, next_offset: 3 });
        }
        case '/api/v2/product/get_item_base_info': {
          const ids = q.get('item_id_list')!.split(',').map(Number);
          return ok({
            item_list: ids
              .filter((id) => id !== 103) // 103 vanished between list and detail
              .map((id) => ({
                item_id: id,
                item_name: `Đèn ${id}`,
                item_status: id === 102 ? 'UNLIST' : 'NORMAL',
                category_id: 555,
                image: { image_id_list: [`img-${id}`] },
                has_model: id === 101,
                price_info: id === 101 ? undefined : [{ original_price: 99000, current_price: 99000 }],
                stock_info_v2: id === 101 ? undefined : { summary_info: { total_available_stock: 4, total_reserved_stock: 0 }, seller_stock: [{ stock: 4 }] },
                update_time: 1000 + (id - 100),
              })),
          });
        }
        case '/api/v2/product/get_model_list':
          return ok({
            tier_variation: [{ name: 'Màu', option_list: [{ option: 'Cam', image: { image_id: 'img-cam' } }, { option: 'Hồng' }] }],
            model: [
              { model_id: 9001, tier_index: [0], price_info: [{ original_price: 299000, current_price: 249000 }], stock_info_v2: { summary_info: { total_available_stock: 2 } } },
              { model_id: 9002, tier_index: [1], price_info: [{ original_price: 299000, current_price: 299000 }], stock_info_v2: { summary_info: { total_available_stock: 0 } } },
            ],
          });
        case '/api/v2/product/get_item_extra_info':
          return ok({ item_list: [{ item_id: 101, sale: 5, views: 50, likes: 3 }] });
        default:
          return { error: 'error_not_found', message: path };
      }
    };
  }

  it('full sync → staged session READY_FOR_PREVIEW → preview → commit publishes through the existing pipeline', async () => {
    const svc = build();
    await connectShop(svc);
    mockCatalog();

    const started = await svc.productSync.startFullSync(ADMIN_ID, false, false);
    expect(started.source).toBe('OPEN_API');
    const session = await waitFor(async () => {
      const s = await models.session.findById(started.id).lean();
      return s && ['READY_FOR_PREVIEW', 'FAILED'].includes(s.status) ? s : null;
    });
    expect(session).toMatchObject({ status: 'READY_FOR_PREVIEW', expectedTotal: ITEMS.length, newCount: 3, failedCount: 1, adapterVersion: 'shopee-open-api-v2' });

    const preview = await svc.sync.preview(started.id);
    expect(preview.newProducts.map((p) => p.externalProductId).sort()).toEqual(['101', '102']);
    expect(preview.failedProducts).toEqual([expect.objectContaining({ externalProductId: '103', errorCode: 'SHOPEE_DETAIL_API_ERROR' })]);

    const commit = await svc.sync.commit(started.id, ADMIN_ID);
    expect(commit).toMatchObject({ status: 'COMMITTED', publishedCount: 2 });

    const p101 = await models.product.findOne({ externalProductId: '101' }).lean();
    expect(p101).toMatchObject({ name: 'Đèn 101', sellingPriceMin: '249000', availableStock: 2, sourceModifiedAt: 1001, soldCount: 5, rawStatus: 1 });
    const variants = await models.variant.find({ marketplaceProductId: p101!._id }).lean();
    expect(variants.map((v) => [v.externalVariantId, v.variantName, v.effectivePrice, v.imageId]).sort()).toEqual([
      ['9001', 'Cam', '249000', 'img-cam'],
      ['9002', 'Hồng', '299000', null],
    ]);
    const p102 = await models.product.findOne({ externalProductId: '102' }).lean();
    expect(p102).toMatchObject({ rawStatus: 8, sellingPriceMin: '99000', availableStock: 4 });

    // Second run with nothing changed on Shopee → no Detail calls for unchanged items.
    fetchMock.mockClear();
    const again = await svc.productSync.startFullSync(ADMIN_ID, false, false);
    const s2 = await waitFor(async () => {
      const s = await models.session.findById(again.id).lean();
      return s && s.status === 'READY_FOR_PREVIEW' ? s : null;
    });
    expect(s2).toMatchObject({ unchangedCount: 2, newCount: 1 }); // 103 still new (never committed)
    const baseCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_item_base_info'));
    expect(baseCalls).toHaveLength(1);
    expect(new URL(String(baseCalls[0][0])).searchParams.get('item_id_list')).toBe('103');
  });

  it('manual sync by id + one running job at a time', async () => {
    const svc = build();
    await connectShop(svc);
    mockCatalog();
    const started = await svc.productSync.startManualSync(ADMIN_ID, ['102']);
    await expect(svc.productSync.startFullSync(ADMIN_ID, false, false)).rejects.toThrow(/Đang có một phiên/);
    const s = await waitFor(async () => {
      const x = await models.session.findById(started.id).lean();
      return x && x.status === 'READY_FOR_PREVIEW' ? x : null;
    });
    expect(s.syncMode).toBe('MANUAL');
    const item = await models.item.findOne({ syncSessionId: s._id }).lean();
    expect(item).toMatchObject({ detailUploaded: true, sourceModifiedAt: 1002 });
  });

  it('a fatal Shopee error fails the session with its code', async () => {
    const svc = build();
    await connectShop(svc);
    shopeeHandler = () => ({ error: 'error_permission', message: 'No permission for product API' });
    const started = await svc.productSync.startFullSync(ADMIN_ID, false, false);
    const s = await waitFor(async () => {
      const x = await models.session.findById(started.id).lean();
      return x && x.status === 'FAILED' ? x : null;
    });
    expect(s.errorCode).toBe('error_permission');
  });
});

describe('order sync via Open API', () => {
  it('lists by update_time, fetches detail/tracking/escrow and imports with exact payout + item-id product link', async () => {
    const svc = build();
    await connectShop(svc);
    // Product 101 was published to the catalog earlier → linked by item_id even though names differ.
    await models.product.create({
      channel: MarketplaceChannel.SHOPEE,
      shopId: 'luxe-glow-main',
      externalProductId: '101',
      internalProductId: svc.catalogProductId,
      name: 'Đèn 101',
      rawStatus: 1,
      priceMin: '0', priceMax: '0', sellingPriceMin: '0', sellingPriceMax: '0',
      availableStock: 0, sellerStock: 0, shopeeStock: 0,
      sourceCreatedAt: 0, sourceModifiedAt: 0, sourceHash: 'x', lastSyncedAt: new Date(),
    });

    shopeeHandler = (path, q) => {
      switch (path) {
        case '/api/v2/order/get_order_list':
          expect(q.get('time_range_field')).toBe('update_time');
          expect(Number(q.get('time_to')) - Number(q.get('time_from'))).toBeLessThanOrEqual(15 * 86400);
          return ok({
            more: false,
            next_cursor: '',
            order_list: [
              { order_sn: 'SN-DONE', order_status: 'COMPLETED' },
              { order_sn: 'SN-NEW', order_status: 'READY_TO_SHIP' },
              { order_sn: 'SN-GONE', order_status: 'SHIPPED' },
              { order_sn: 'SN-UNPAID', order_status: 'UNPAID' },
            ],
          });
        case '/api/v2/order/get_order_detail':
          expect(q.get('order_sn_list')).not.toContain('SN-UNPAID');
          return ok({
            order_list: [
              {
                order_sn: 'SN-DONE', order_status: 'COMPLETED', create_time: 1761700000, total_amount: 162000, buyer_username: 'buyer_a',
                recipient_address: { name: 'N***', phone: '******17', state: 'TP. Hồ Chí Minh', town: 'Phường Bến Nghé', full_address: '1 Lê Lợi' },
                item_list: [{ item_id: 101, item_name: 'Tên Shopee khác hẳn', model_name: 'Cam', model_quantity_purchased: 1, model_discounted_price: 145000 }],
                package_list: [{ package_number: 'PKG1' }],
              },
              {
                order_sn: 'SN-NEW', order_status: 'READY_TO_SHIP', create_time: 1761700500, total_amount: 50000, buyer_username: 'buyer_b',
                recipient_address: { name: 'B***' },
                item_list: [{ item_id: 999, item_name: 'Sản phẩm chưa có', model_quantity_purchased: 1, model_discounted_price: 50000 }],
              },
            ],
          });
        case '/api/v2/logistics/get_tracking_number':
          return ok({ tracking_number: 'SPXVN0001' });
        case '/api/v2/payment/get_escrow_detail':
          return ok({ order_sn: q.get('order_sn'), order_income: { escrow_amount: 104217, buyer_paid_shipping_fee: 17000 } });
        default:
          return { error: 'error_not_found', message: path };
      }
    };

    const batch = await svc.orderApiSync.startManualSync(ADMIN_ID, { from: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    expect(batch.status).toBe('RUNNING');
    const done = await waitFor(async () => {
      const b = await models.batch.findById(batch._id).lean();
      return b && b.status !== 'RUNNING' ? b : null;
    });
    expect(done).toMatchObject({ status: 'COMPLETED', source: 'OPEN_API', createdCount: 1, needsReviewCount: 1, failedCount: 1, totalOrders: 3 });
    expect(done.rows.find((r) => r.orderCode === 'SN-GONE')).toMatchObject({ status: 'FAILED' });

    // 20 days → two 15-day windows.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_order_list'))).toHaveLength(2);

    expect(svc.createdOrders).toHaveLength(1);
    expect(svc.createdOrders[0]).toMatchObject({
      channel: 'SHOPEE',
      code: 'SN-DONE',
      packageCode: 'PKG1',
      status: OrderStatus.DELIVERED,
      paidAmount: 104217,
      subtotal: 145000,
      shippingFee: 17000,
      total: 162000,
      delivery: { trackingCode: 'SPXVN0001' },
      buyer: { externalBuyerId: 'buyer_a' },
      items: [expect.objectContaining({ productId: svc.catalogProductId.toString(), color: 'Cam', unitPrice: 145000 })],
    });

    const issue = await models.issue.findOne({ orderCode: 'SN-NEW' }).lean();
    expect(issue).toMatchObject({ status: 'OPEN' });
    // Address Shopee didn't return → stored as masked, never as an invalid empty value.
    expect(issue!.shippingInfoPreview).toMatchObject({ recipientName: 'B***', phone: '***', street: '***', city: '***' });
    expect((issue!.rawRows as Record<string, string>[])[0].__apiOrderStatus).toBe('READY_TO_SHIP');

    // Lock released + last sync time recorded.
    const cred = await models.cred.findOne({ key: SHOPEE_CREDENTIAL_KEY }).lean();
    expect(cred!.orderSyncLockUntil).toBeUndefined();
    expect(cred!.lastOrderSyncAt).toBeInstanceOf(Date);
  });
});
