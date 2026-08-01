import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarketplaceProductUploadDto, UploadProductDetailDto } from './marketplace-product-upload.dto';
import { MarketplaceImageType } from '../schemas/marketplace-product-image.schema';

const VALIDATION_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function validProductPayload(overrides: Record<string, unknown> = {}) {
  return {
    source: 'SHOPEE',
    externalProductId: '53060703063',
    name: 'Đèn bàn cổ điển',
    rawStatus: 1,
    parentSku: null,
    coverImageId: 'img-1',
    images: [{ sourceImageId: 'img-1', sourceUrl: 'https://down-vn.img.susercontent.com/file/img-1', imageType: MarketplaceImageType.COVER, position: 0 }],
    description: 'Mô tả',
    descriptionType: 'text',
    categoryIds: [100001],
    categoryNames: ['Đèn Bàn'],
    condition: 1,
    brandId: null,
    brandName: null,
    priceMin: '100000',
    priceMax: '100000',
    sellingPriceMin: '100000',
    sellingPriceMax: '100000',
    availableStock: 10,
    sellerStock: 10,
    shopeeStock: 0,
    soldCount: 0,
    viewCount: 0,
    likedCount: 0,
    weightValue: '500',
    weightUnit: 1,
    dimension: { width: '10', length: '10', height: '10' },
    preOrder: false,
    daysToShip: 2,
    sourceCreatedAt: 1_600_000_000,
    sourceModifiedAt: 1_700_000_000,
    variants: [
      {
        externalVariantId: '1000',
        name: null,
        isDefault: true,
        sku: null,
        tierIndexes: [],
        imageId: null,
        imageUrl: null,
        normalPrice: '100000',
        promotionPrice: '0',
        effectivePrice: '100000',
        availableStock: 10,
        sellerStock: 10,
        shopeeStock: 0,
        reservedStock: 0,
        soldCount: 0,
        availableStatus: 1,
        preOrder: false,
        daysToShip: 2,
      },
    ],
    ...overrides,
  };
}

describe('MarketplaceProductUploadDto', () => {
  it('accepts a well-formed product with a single default (no-variation) model', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload());
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts the synthetic default model with an empty/null name (test #17)', async () => {
    const dto = plainToInstance(
      MarketplaceProductUploadDto,
      validProductPayload({ variants: [{ ...validProductPayload().variants[0], name: null, isDefault: true }] }),
    );
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
    expect(dto.variants[0].name).toBeNull();
    expect(dto.variants[0].isDefault).toBe(true);
  });

  it('rejects a product with zero variants — Shopee always has at least the default model', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ variants: [] }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.some((e) => e.property === 'variants')).toBe(true);
  });

  it('rejects a non-numeric price string', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ priceMin: 'abc' }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.some((e) => e.property === 'priceMin')).toBe(true);
  });

  it('rejects an unexpected field anywhere in the payload (never trust extra client data)', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ shopeeCookie: 'abc' }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.some((e) => e.property === 'shopeeCookie')).toBe(true);
  });

  it('rejects an unexpected field nested inside a variant', async () => {
    const payload = validProductPayload();
    (payload.variants[0] as Record<string, unknown>).spcCds = 'abc';
    const dto = plainToInstance(MarketplaceProductUploadDto, payload);
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a tierVariations entry with a blank name (not a required field, only options matters)', async () => {
    const dto = plainToInstance(
      MarketplaceProductUploadDto,
      validProductPayload({ tierVariations: [{ name: '', options: ['Xanh lá', 'Hồng', 'Cam'] }] }),
    );
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a payload with no tierVariations at all (no-variation product)', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ tierVariations: [] }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a well-formed videoId (a CDN path containing "/")', async () => {
    const dto = plainToInstance(
      MarketplaceProductUploadDto,
      validProductPayload({ videoId: 'api/v4/11110107/mms/vn-11110107-6va08-mr1ciuzjh7nwd2.16000081784879360.mp4' }),
    );
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a payload with no videoId (product has no video)', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ videoId: null }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('rejects a videoId containing characters outside a safe CDN path (e.g. a foreign URL)', async () => {
    const dto = plainToInstance(MarketplaceProductUploadDto, validProductPayload({ videoId: 'https://evil.com/x' }));
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.some((e) => e.property === 'videoId')).toBe(true);
  });
});


describe('UploadProductDetailDto', () => {
  it('accepts a failure report without a product payload', async () => {
    const dto = plainToInstance(UploadProductDetailDto, {
      failed: true,
      errorCode: 'SHOPEE_DETAIL_API_ERROR',
      errorMessage: 'HTTP 500',
    });
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a successful payload wrapping a valid product', async () => {
    const dto = plainToInstance(UploadProductDetailDto, { product: validProductPayload() });
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });
});
