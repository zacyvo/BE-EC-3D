import { buildColorsAndSizes, buildShopeeSocialLink, mergeShopeeSocial } from './shopee-catalog-publish.service';
import { SocialPlatform } from '../products/schemas/product.schema';

describe('buildColorsAndSizes', () => {
  it('returns empty colors/sizes when the product has no variation tiers', () => {
    const result = buildColorsAndSizes([], [{ tierIndexes: [], imageUrl: null }]);
    expect(result).toEqual({ colors: [], sizes: [] });
  });

  it('maps tier 1 to colors (by index, not by name) with a representative image per option', () => {
    const tierVariations = [{ name: 'Màu sắc', options: ['Đỏ', 'Xanh'] }];
    const variants = [
      { tierIndexes: [0], imageUrl: 'https://down-vn.img.susercontent.com/file/red.jpg' },
      { tierIndexes: [1], imageUrl: 'https://down-vn.img.susercontent.com/file/blue.jpg' },
    ];
    const result = buildColorsAndSizes(tierVariations, variants);
    expect(result.colors).toEqual([
      { name: 'Đỏ', images: ['https://down-vn.img.susercontent.com/file/red.jpg'] },
      { name: 'Xanh', images: ['https://down-vn.img.susercontent.com/file/blue.jpg'] },
    ]);
    expect(result.sizes).toEqual([]);
  });

  it('maps tier 2 to plain size names (no per-size price/stock in the Product schema)', () => {
    const tierVariations = [
      { name: 'Màu sắc', options: ['Đỏ'] },
      { name: 'Kích thước', options: ['S', 'M', 'L'] },
    ];
    const variants = [
      { tierIndexes: [0, 0], imageUrl: 'https://down-vn.img.susercontent.com/file/red.jpg' },
      { tierIndexes: [0, 1], imageUrl: 'https://down-vn.img.susercontent.com/file/red.jpg' },
      { tierIndexes: [0, 2], imageUrl: 'https://down-vn.img.susercontent.com/file/red.jpg' },
    ];
    const result = buildColorsAndSizes(tierVariations, variants);
    expect(result.sizes).toEqual(['S', 'M', 'L']);
    expect(result.colors).toEqual([{ name: 'Đỏ', images: ['https://down-vn.img.susercontent.com/file/red.jpg'] }]);
  });

  it('gives a color option an empty images array when no variant matches its index', () => {
    const tierVariations = [{ name: 'Màu sắc', options: ['Đỏ', 'Xanh'] }];
    const variants = [{ tierIndexes: [0], imageUrl: 'https://down-vn.img.susercontent.com/file/red.jpg' }];
    const result = buildColorsAndSizes(tierVariations, variants);
    expect(result.colors).toEqual([
      { name: 'Đỏ', images: ['https://down-vn.img.susercontent.com/file/red.jpg'] },
      { name: 'Xanh', images: [] },
    ]);
  });

  it('drops blank size option names', () => {
    const tierVariations = [{ name: 'Màu sắc', options: ['Đỏ'] }, { name: 'Kích thước', options: ['S', '  ', 'L'] }];
    const variants = [{ tierIndexes: [0, 0], imageUrl: null }];
    const result = buildColorsAndSizes(tierVariations, variants);
    expect(result.sizes).toEqual(['S', 'L']);
  });
});

describe('buildShopeeSocialLink (real Shopee URL format: https://shopee.vn/{slug}-i.{shop_id}.{product_id})', () => {
  const TEMPLATE = 'https://shopee.vn/{product_slug}-i.{shop_id}.{product_id}';

  it('fills product_slug/shop_id/product_id from the product name + confirmed public shop id', () => {
    const url = buildShopeeSocialLink('76624421', '53060703063', 'Đèn bàn cổ điển', TEMPLATE);
    expect(url).toBe('https://shopee.vn/djen-ban-co-djien-i.76624421.53060703063');
  });

  it('falls back to a generic slug when the product name has no sluggable characters', () => {
    const url = buildShopeeSocialLink('76624421', '1', '!!!', TEMPLATE);
    expect(url).toBe('https://shopee.vn/san-pham-i.76624421.1');
  });
});

describe('mergeShopeeSocial (test: liên kết mạng xã hội/sàn TMĐT — không ghi đè platform khác)', () => {
  it('adds the SHOPEE entry when none existed before', () => {
    const result = mergeShopeeSocial([], { name: SocialPlatform.SHOPEE, id: '1', link: 'https://shopee.vn/product/1/1' });
    expect(result).toEqual([{ name: SocialPlatform.SHOPEE, id: '1', link: 'https://shopee.vn/product/1/1' }]);
  });

  it('replaces an existing SHOPEE entry without touching other platforms', () => {
    const existing = [
      { name: SocialPlatform.FACEBOOK, link: 'https://facebook.com/abc' },
      { name: SocialPlatform.SHOPEE, id: 'old', link: 'https://shopee.vn/product/1/old' },
    ];
    const result = mergeShopeeSocial(existing, { name: SocialPlatform.SHOPEE, id: 'new', link: 'https://shopee.vn/product/1/new' });
    expect(result).toEqual([
      { name: SocialPlatform.FACEBOOK, link: 'https://facebook.com/abc' },
      { name: SocialPlatform.SHOPEE, id: 'new', link: 'https://shopee.vn/product/1/new' },
    ]);
  });
});
