import { diffImageIds, diffProductFields, diffVariants } from './shopee-sync-preview.util';

describe('diffProductFields (test: preview diff — Name/Status/Description/Category/Price/Stock)', () => {
  const existing = {
    name: 'Đèn bàn cổ điển',
    rawStatus: 1,
    description: 'Mô tả cũ',
    categoryNames: ['Đèn Bàn'],
    sellingPriceMin: '100000',
    sellingPriceMax: '150000',
    availableStock: 10,
  };

  it('returns no changes for identical products', () => {
    expect(diffProductFields(existing, { ...existing })).toEqual([]);
  });

  it('detects a name change', () => {
    const changes = diffProductFields(existing, { ...existing, name: 'Đèn bàn mới' });
    expect(changes).toContainEqual({ field: 'name', oldValue: existing.name, newValue: 'Đèn bàn mới' });
  });

  it('detects status/description/category/price/stock changes independently', () => {
    const changes = diffProductFields(existing, {
      ...existing,
      rawStatus: 0,
      description: 'Mô tả mới',
      categoryNames: ['Đèn Trần'],
      sellingPriceMin: '90000',
      availableStock: 5,
    });
    const fields = changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['status', 'description', 'category', 'priceRange', 'availableStock']));
  });
});

describe('diffVariants (test #20 — variant added/updated/missing)', () => {
  const existing = [
    {
      externalVariantId: 'v1',
      sku: 'SKU-1',
      normalPrice: '100000',
      promotionPrice: '0',
      effectivePrice: '100000',
      availableStock: 10,
      imageId: 'img-1',
      isActive: true,
    },
    {
      externalVariantId: 'v2',
      sku: 'SKU-2',
      normalPrice: '200000',
      promotionPrice: '0',
      effectivePrice: '200000',
      availableStock: 5,
      imageId: null,
      isActive: true,
    },
  ];

  it('flags a brand new externalVariantId as ADDED', () => {
    const incoming = [
      ...existing.map(({ isActive: _isActive, ...v }) => v),
      { externalVariantId: 'v3', sku: 'SKU-3', normalPrice: '50000', promotionPrice: '0', effectivePrice: '50000', availableStock: 1, imageId: null },
    ];
    const diff = diffVariants(existing, incoming);
    expect(diff).toContainEqual({ externalVariantId: 'v3', changeType: 'ADDED', changes: [] });
  });

  it('flags a variant no longer present as MISSING (not deleted)', () => {
    const incoming = [{ externalVariantId: 'v1', sku: 'SKU-1', normalPrice: '100000', promotionPrice: '0', effectivePrice: '100000', availableStock: 10, imageId: 'img-1' }];
    const diff = diffVariants(existing, incoming);
    expect(diff).toContainEqual({ externalVariantId: 'v2', changeType: 'MISSING', changes: [] });
  });

  it('flags a price/stock change as UPDATED with the specific field changes', () => {
    const incoming = [
      { externalVariantId: 'v1', sku: 'SKU-1', normalPrice: '100000', promotionPrice: '79000', effectivePrice: '79000', availableStock: 3, imageId: 'img-1' },
      { externalVariantId: 'v2', sku: 'SKU-2', normalPrice: '200000', promotionPrice: '0', effectivePrice: '200000', availableStock: 5, imageId: null },
    ];
    const diff = diffVariants(existing, incoming);
    const v1Diff = diff.find((d) => d.externalVariantId === 'v1');
    expect(v1Diff?.changeType).toBe('UPDATED');
    expect(v1Diff?.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['promotionPrice', 'effectivePrice', 'availableStock']));
  });

  it('ignores inactive existing variants when computing ADDED (already-removed variant should not resurrect as UPDATED)', () => {
    const withInactive = [...existing, { externalVariantId: 'v-old', sku: null, normalPrice: '1', promotionPrice: '0', effectivePrice: '1', availableStock: 0, imageId: null, isActive: false }];
    const incoming = existing.map(({ isActive: _isActive, ...v }) => v);
    const diff = diffVariants(withInactive, incoming);
    expect(diff.find((d) => d.externalVariantId === 'v-old')).toBeUndefined();
  });
});

describe('diffImageIds', () => {
  it('reports added and removed image ids', () => {
    const result = diffImageIds(['a', 'b'], ['b', 'c']);
    expect(result).toEqual({ added: ['c'], removed: ['a'] });
  });

  it('reports no changes for identical sets', () => {
    expect(diffImageIds(['a', 'b'], ['a', 'b'])).toEqual({ added: [], removed: [] });
  });
});
