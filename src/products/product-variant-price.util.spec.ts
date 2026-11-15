import { computeFinalPrice, resolveUnitPrice, sanitizeVariantPrices } from './product-variant-price.util';

describe('sanitizeVariantPrices (giá theo phân loại)', () => {
  it('keeps entries for existing color/size combinations and computes finalPrice from the discount', () => {
    const out = sanitizeVariantPrices(
      [
        { color: 'Đỏ', size: '20cm', sellingPrice: 100000 },
        { color: 'Xanh', size: '30cm', sellingPrice: 150000, sku: ' SKU-1 ' },
      ],
      ['Đỏ', 'Xanh'],
      ['20cm', '30cm'],
      10,
    );
    expect(out).toEqual([
      { color: 'Đỏ', size: '20cm', sellingPrice: 100000, finalPrice: 90000 },
      { color: 'Xanh', size: '30cm', sellingPrice: 150000, finalPrice: 135000, sku: 'SKU-1' },
    ]);
  });

  it('drops entries for removed options, missing axes, extra axes, blanks, duplicates and bad prices', () => {
    const out = sanitizeVariantPrices(
      [
        { color: 'Tím', sellingPrice: 1 }, // color no longer exists
        { color: 'Đỏ', sellingPrice: 2 }, // sizes configured but entry has none
        { color: 'Đỏ', size: '20cm', sellingPrice: -5 }, // negative
        { color: 'Đỏ', size: '20cm', sellingPrice: Number.NaN },
        { color: ' Đỏ ', size: '20cm', sellingPrice: 3 }, // trimmed → kept
        { color: 'Đỏ', size: '20cm', sellingPrice: 4 }, // duplicate → dropped
        { sellingPrice: 5 }, // neither axis
      ],
      ['Đỏ'],
      ['20cm'],
    );
    expect(out).toEqual([{ color: 'Đỏ', size: '20cm', sellingPrice: 3, finalPrice: 3 }]);
  });

  it('supports single-axis products (colors only or sizes only)', () => {
    expect(sanitizeVariantPrices([{ color: 'Đỏ', sellingPrice: 10 }, { color: 'Đỏ', size: 'M', sellingPrice: 11 }], ['Đỏ'], [])).toEqual([
      { color: 'Đỏ', sellingPrice: 10, finalPrice: 10 },
    ]);
    expect(sanitizeVariantPrices([{ size: 'M', sellingPrice: 10 }], [], ['M'])).toEqual([{ size: 'M', sellingPrice: 10, finalPrice: 10 }]);
  });
});

describe('resolveUnitPrice', () => {
  const product = {
    finalPrice: 50000,
    variants: [
      { color: 'Đỏ', size: '20cm', finalPrice: 60000 },
      { color: 'Xanh', size: '20cm', finalPrice: 80000 },
    ],
  };

  it('uses the selected variant price', () => {
    expect(resolveUnitPrice(product, 'Xanh', '20cm')).toBe(80000);
    expect(resolveUnitPrice(product, 'Đỏ', '20cm')).toBe(60000);
  });

  it('falls back to the product price for an unpriced combination or a product without variants', () => {
    expect(resolveUnitPrice(product, 'Đỏ', '30cm')).toBe(50000);
    expect(resolveUnitPrice({ finalPrice: 42000 }, undefined, undefined)).toBe(42000);
  });

  it('computeFinalPrice rounds like the product price', () => {
    expect(computeFinalPrice(99999, 15)).toBe(84999);
  });
});
