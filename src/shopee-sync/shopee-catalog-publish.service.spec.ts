import { buildColorsAndSizes } from './shopee-catalog-publish.service';

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
