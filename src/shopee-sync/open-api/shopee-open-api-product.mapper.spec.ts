import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MarketplaceProductUploadDto } from '../dto/marketplace-product-upload.dto';
import { extractVideoId, mapShopeeItemToUpload, ShopeeProductMappingError } from './shopee-open-api-product.mapper';
import type { ShopeeItemBaseInfo, ShopeeModelListResponse } from './shopee-open-api.types';

const OPTS = {
  imageUrlTemplate: 'https://down-vn.img.susercontent.com/file/{image_id}',
  videoUrlTemplate: 'https://cvf.shopee.vn/file/{video_id}',
};

const stock = (available: number, reserved = 0) => ({
  summary_info: { total_available_stock: available, total_reserved_stock: reserved },
  seller_stock: [{ location_id: 'VNZ', stock: available + reserved }],
  shopee_stock: [],
});

const base: ShopeeItemBaseInfo = {
  item_id: 25988349424,
  category_id: 101234,
  item_name: 'Đèn Loopy Lamp',
  description: 'Loopy Lamp mô tả',
  description_type: 'normal',
  create_time: 1720000000,
  update_time: 1730000000,
  image: { image_id_list: ['vn-img-1', 'vn-img-2'], image_url_list: [] },
  weight: '0.6',
  dimension: { package_length: 20, package_width: 0, package_height: 10 },
  pre_order: { is_pre_order: false, days_to_ship: 2 },
  condition: 'NEW',
  item_status: 'NORMAL',
  has_model: true,
  brand: { brand_id: 6264147, original_brand_name: 'LUXE GLOW' },
  video_info: [{ video_url: 'https://cvf.shopee.vn/file/api/v4/11110105/mms/vn-abc.16000081.mp4' }],
};

const models: ShopeeModelListResponse = {
  tier_variation: [
    {
      name: 'Màu sắc',
      option_list: [{ option: 'Xanh lá', image: { image_id: 'vn-green' } }, { option: 'Hồng' }, { option: 'Cam', image: { image_id: 'vn-orange' } }],
    },
  ],
  model: [
    { model_id: 425937875292, tier_index: [2], model_sku: '', price_info: [{ original_price: 299000, current_price: 249000 }], stock_info_v2: stock(5, 1) },
    { model_id: 425937875294, tier_index: [0], model_sku: 'LL-G', price_info: [{ original_price: 299000, current_price: 299000 }], stock_info_v2: stock(3) },
    { model_id: 425937875295, tier_index: [1], price_info: [{ original_price: 279000, current_price: 279000 }], stock_info_v2: stock(0) },
  ],
};

describe('mapShopeeItemToUpload', () => {
  it('produces the same normalized shape the extension uploads (and passes the upload DTO)', () => {
    const p = mapShopeeItemToUpload(base, models, { item_id: base.item_id, sale: 12, views: 340, likes: 7 }, { ...OPTS, listUpdateTime: 1730000500 });

    expect(p.externalProductId).toBe('25988349424');
    expect(p.rawStatus).toBe(1);
    expect(p.condition).toBe(1);
    expect(p.coverImageId).toBe('vn-img-1');
    expect(p.images.map((i) => [i.imageType, i.sourceImageId, i.position])).toEqual([
      ['COVER', 'vn-img-1', 0],
      ['GALLERY', 'vn-img-1', 0],
      ['GALLERY', 'vn-img-2', 1],
    ]);
    expect(p.images[0].sourceUrl).toBe('https://down-vn.img.susercontent.com/file/vn-img-1');
    expect(p.videoId).toBe('api/v4/11110105/mms/vn-abc.16000081.mp4');
    expect(p.weightValue).toBe('600');
    expect(p.weightUnit).toBe(2);
    expect(p.dimension).toEqual({ width: null, length: '20', height: '10' });
    expect(p.tierVariations).toEqual([{ name: 'Màu sắc', options: ['Xanh lá', 'Hồng', 'Cam'] }]);
    expect(p.sourceModifiedAt).toBe(1730000500); // list update_time wins — that's what was diffed
    expect([p.soldCount, p.viewCount, p.likedCount]).toEqual([12, 340, 7]);

    const orange = p.variants.find((v) => v.externalVariantId === '425937875292')!;
    expect(orange).toMatchObject({
      name: 'Cam',
      normalPrice: '299000',
      promotionPrice: '249000',
      effectivePrice: '249000',
      imageId: 'vn-orange',
      availableStock: 5,
      reservedStock: 1,
      sellerStock: 6,
      sku: null,
    });
    const green = p.variants.find((v) => v.externalVariantId === '425937875294')!;
    expect(green).toMatchObject({ promotionPrice: '0', effectivePrice: '299000', sku: 'LL-G', imageId: 'vn-green' });
    expect(p.variants.find((v) => v.externalVariantId === '425937875295')!.imageId).toBeNull();

    expect([p.priceMin, p.priceMax, p.sellingPriceMin, p.sellingPriceMax]).toEqual(['279000', '299000', '249000', '299000']);
    expect(p.availableStock).toBe(8);

    expect(validateSync(plainToInstance(MarketplaceProductUploadDto, p))).toEqual([]);
  });

  it('no-variation item → one default variant from item-level price/stock, reusing the existing variant id', () => {
    const single: ShopeeItemBaseInfo = {
      ...base,
      has_model: false,
      price_info: [{ original_price: 150000, current_price: 120000 }],
      stock_info_v2: stock(9),
    };
    const p = mapShopeeItemToUpload(single, null, null, { ...OPTS, existingDefaultVariantId: '987654' });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]).toMatchObject({ externalVariantId: '987654', isDefault: true, normalPrice: '150000', effectivePrice: '120000', availableStock: 9 });
    expect(mapShopeeItemToUpload(single, null, null, OPTS).variants[0].externalVariantId).toBe('0');
    expect(validateSync(plainToInstance(MarketplaceProductUploadDto, p))).toEqual([]);
  });

  it('extended description keeps only the text fields', () => {
    const p = mapShopeeItemToUpload(
      {
        ...base,
        description: undefined,
        description_type: 'extended',
        description_info: {
          extended_description: { field_list: [{ field_type: 'text', text: 'Dòng 1' }, { field_type: 'image', image_info: { image_id: 'x' } }, { field_type: 'text', text: 'Dòng 2' }] },
        },
      },
      models,
      null,
      OPTS,
    );
    expect(p.description).toBe('Dòng 1\nDòng 2');
  });

  it('fails the product (not the job) on unusable data', () => {
    expect(() => mapShopeeItemToUpload({ ...base, item_name: ' ' }, models, null, OPTS)).toThrow(ShopeeProductMappingError);
    expect(() => mapShopeeItemToUpload(base, { model: [] }, null, OPTS)).toThrow(/has_model/);
  });

  it('extractVideoId only accepts URLs under the configured template prefix', () => {
    expect(extractVideoId('https://evil.example.com/file/x.mp4', OPTS.videoUrlTemplate)).toBeNull();
    expect(extractVideoId('https://cvf.shopee.vn/file/a/b.mp4?x=1', OPTS.videoUrlTemplate)).toBe('a/b.mp4');
    expect(extractVideoId(undefined, OPTS.videoUrlTemplate)).toBeNull();
  });
});
