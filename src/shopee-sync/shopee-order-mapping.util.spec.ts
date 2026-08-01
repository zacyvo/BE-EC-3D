import * as XLSX from 'xlsx';
import { OrderStatus } from '../orders/schemas/order.schema';
import { ShopeeSyncException } from './shopee-sync.exceptions';
import {
  SHOPEE_ORDER_COLUMNS,
  parseShopeeOrderWorkbook,
  groupRowsByOrderCode,
  parseVndAmount,
  parseShopeeDate,
  mapShopeeOrderStatus,
  isMasked,
  isValidVnMobile,
  normalizeVnPhone,
  buildShippingPreviewFromGroup,
  computeOrderMoney,
  stripDiacritics,
  normalizeNameForMatch,
  jaccardSimilarity,
  findBestProductMatches,
  matchVariantToColorOrSize,
  ShopeeOrderRawRow,
} from './shopee-order-mapping.util';

const ALL_COLUMNS = Object.values(SHOPEE_ORDER_COLUMNS);

function buildWorkbookBuffer(rows: Partial<Record<string, string>>[], columns: string[] = ALL_COLUMNS): Buffer {
  const aoa = [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'orders');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function baseRow(overrides: Partial<Record<string, string>> = {}): Partial<Record<string, string>> {
  return {
    [SHOPEE_ORDER_COLUMNS.orderCode]: 'ORDER001',
    [SHOPEE_ORDER_COLUMNS.status]: 'Chờ giao hàng',
    [SHOPEE_ORDER_COLUMNS.productName]: 'Móc khoá Test Series',
    [SHOPEE_ORDER_COLUMNS.variantName]: '1 ô',
    [SHOPEE_ORDER_COLUMNS.quantity]: '1',
    [SHOPEE_ORDER_COLUMNS.offerPrice]: '17000.00',
    [SHOPEE_ORDER_COLUMNS.shippingFeePaidByBuyer]: '0.00',
    [SHOPEE_ORDER_COLUMNS.orderTotalPaid]: '17000.00',
    [SHOPEE_ORDER_COLUMNS.buyerUsername]: 'testbuyer99',
    [SHOPEE_ORDER_COLUMNS.recipientName]: 'N******n',
    [SHOPEE_ORDER_COLUMNS.phone]: '******78',
    [SHOPEE_ORDER_COLUMNS.province]: 'Thành phố Hà Nội',
    [SHOPEE_ORDER_COLUMNS.wardLegacyLabel]: 'Phường Cầu Giấy',
    [SHOPEE_ORDER_COLUMNS.district]: '',
    [SHOPEE_ORDER_COLUMNS.address]: '******, Phường Cầu Giấy, Thành phố Hà Nội',
    ...overrides,
  };
}

describe('parseShopeeOrderWorkbook', () => {
  it('parses rows keyed by the exact Shopee header text', () => {
    const buffer = buildWorkbookBuffer([baseRow()]);
    const rows = parseShopeeOrderWorkbook(buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0][SHOPEE_ORDER_COLUMNS.orderCode]).toBe('ORDER001');
  });

  it('drops rows outside the actual data range even when the sheet dimension claims more rows exist (matches real Order.completed export: !ref was A1:BI208 with only 2 populated rows)', () => {
    const buffer = buildWorkbookBuffer([baseRow()]);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet['!ref']!);
    sheet['!ref'] = XLSX.utils.encode_range({ s: range.s, e: { r: range.e.r + 20, c: range.e.c } });
    const paddedBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const rows = parseShopeeOrderWorkbook(paddedBuffer);
    expect(rows).toHaveLength(1);
  });

  it('normalizes inconsistent per-cell Unicode forms to NFC (real gotcha: a re-saved Order.completed export had one header/value pair in NFD while sibling cells stayed NFC, silently breaking exact-string column lookups)', () => {
    const nfdOfferPriceHeader = SHOPEE_ORDER_COLUMNS.offerPrice.normalize('NFD');
    expect(nfdOfferPriceHeader).not.toBe(SHOPEE_ORDER_COLUMNS.offerPrice); // sanity: genuinely different bytes
    const columns = ALL_COLUMNS.map((c) => (c === SHOPEE_ORDER_COLUMNS.offerPrice ? nfdOfferPriceHeader : c));
    const row = baseRow();
    const aoa = [columns, ALL_COLUMNS.map((c) => row[c] ?? '')];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'orders');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const rows = parseShopeeOrderWorkbook(buffer);
    expect(rows[0][SHOPEE_ORDER_COLUMNS.offerPrice]).toBe('17000.00');
  });

  it('throws ORDER_FILE_INVALID_FORMAT when required columns are missing', () => {
    const buffer = buildWorkbookBuffer([baseRow()], [SHOPEE_ORDER_COLUMNS.orderCode, SHOPEE_ORDER_COLUMNS.status]);
    expect(() => parseShopeeOrderWorkbook(buffer)).toThrow(ShopeeSyncException);
  });

  it('throws ORDER_FILE_EMPTY when the sheet has no data rows', () => {
    const buffer = buildWorkbookBuffer([]);
    expect(() => parseShopeeOrderWorkbook(buffer)).toThrow(ShopeeSyncException);
  });

  it('throws ORDER_FILE_INVALID_FORMAT for a non-Excel buffer', () => {
    expect(() => parseShopeeOrderWorkbook(Buffer.from('not an excel file'))).toThrow(ShopeeSyncException);
  });
});

describe('groupRowsByOrderCode', () => {
  it('groups multiple line-item rows under the same order code', () => {
    const rows = [baseRow({ [SHOPEE_ORDER_COLUMNS.orderCode]: 'A' }), baseRow({ [SHOPEE_ORDER_COLUMNS.orderCode]: 'A' }), baseRow({ [SHOPEE_ORDER_COLUMNS.orderCode]: 'B' })] as ShopeeOrderRawRow[];
    const grouped = groupRowsByOrderCode(rows);
    expect(grouped.size).toBe(2);
    expect(grouped.get('A')).toHaveLength(2);
    expect(grouped.get('B')).toHaveLength(1);
  });

  it('ignores rows with a blank order code', () => {
    const rows = [baseRow({ [SHOPEE_ORDER_COLUMNS.orderCode]: '' })] as ShopeeOrderRawRow[];
    expect(groupRowsByOrderCode(rows).size).toBe(0);
  });
});

describe('parseVndAmount', () => {
  it.each([
    ['17000.00', 17000],
    ['0.00', 0],
    ['', 0],
    [undefined, 0],
    ['not a number', 0],
  ])('parses %s as %d', (input, expected) => {
    expect(parseVndAmount(input)).toBe(expected);
  });
});

describe('parseShopeeDate', () => {
  it('parses Shopee\'s "YYYY-MM-DD HH:mm" format', () => {
    const d = parseShopeeDate('2026-07-29 17:35');
    expect(d).toBeInstanceOf(Date);
    expect(d?.getFullYear()).toBe(2026);
  });

  it('returns undefined for blank/invalid input', () => {
    expect(parseShopeeDate('')).toBeUndefined();
    expect(parseShopeeDate('not a date')).toBeUndefined();
    expect(parseShopeeDate(undefined)).toBeUndefined();
  });
});

describe('mapShopeeOrderStatus', () => {
  it.each([
    ['Chờ xác nhận', OrderStatus.PENDING],
    ['Chờ giao hàng', OrderStatus.PROCESSING],
    ['Chờ lấy hàng', OrderStatus.PROCESSING],
    ['Đang giao', OrderStatus.SHIPPED],
    ['Đã giao', OrderStatus.DELIVERED],
    ['Hoàn thành', OrderStatus.DELIVERED],
    ['Đã hủy', OrderStatus.CANCELLED],
    ['Trả hàng/Hoàn tiền', OrderStatus.CANCELLED],
    ['Một trạng thái lạ chưa từng thấy', OrderStatus.PROCESSING],
  ])('maps "%s" to %s', (raw, expected) => {
    expect(mapShopeeOrderStatus(raw)).toBe(expected);
  });

  it('maps the real Order.completed "still within return window" status to DELIVERED, not CANCELLED', () => {
    const raw =
      'Người mua xác nhận đã nhận được hàng, tuy nhiên Người mua vẫn có thể gửi yêu cầu Trả hàng/Hoàn tiền tới ngày 2026-08-02.';
    expect(mapShopeeOrderStatus(raw)).toBe(OrderStatus.DELIVERED);
  });

  it('treats a non-empty returnStatus column as authoritative CANCELLED regardless of the main status text', () => {
    expect(mapShopeeOrderStatus('Hoàn thành', 'Đã hoàn tiền')).toBe(OrderStatus.CANCELLED);
  });

  it('ignores a blank/whitespace-only returnStatus column', () => {
    expect(mapShopeeOrderStatus('Hoàn thành', '')).toBe(OrderStatus.DELIVERED);
    expect(mapShopeeOrderStatus('Hoàn thành', '   ')).toBe(OrderStatus.DELIVERED);
  });
});

describe('masking helpers', () => {
  it('detects masked values', () => {
    expect(isMasked('B******ỷ')).toBe(true);
    expect(isMasked('Nguyễn Văn A')).toBe(false);
  });

  it('validates VN mobile numbers and rejects masked ones', () => {
    expect(isValidVnMobile('0912345678')).toBe(true);
    expect(isValidVnMobile('******78')).toBe(false);
  });

  it('normalizes +84 prefix to 0', () => {
    expect(normalizeVnPhone('+84912345678')).toBe('0912345678');
    expect(normalizeVnPhone('0912345678')).toBe('0912345678');
  });
});

describe('buildShippingPreviewFromGroup', () => {
  it('reads recipient fields from the first row only', () => {
    const rows = [
      baseRow({ [SHOPEE_ORDER_COLUMNS.note]: 'Giao giờ hành chính' }),
      baseRow({ [SHOPEE_ORDER_COLUMNS.recipientName]: 'DIFFERENT — should be ignored' }),
    ] as ShopeeOrderRawRow[];
    const preview = buildShippingPreviewFromGroup(rows);
    expect(preview.recipientName).toBe('N******n');
    expect(preview.city).toBe('Thành phố Hà Nội');
    expect(preview.ward).toBe('Phường Cầu Giấy');
    expect(preview.note).toContain('Giao giờ hành chính');
  });

  it('combines the shipping note and buyer comment', () => {
    const rows = [
      baseRow({
        [SHOPEE_ORDER_COLUMNS.note]: 'Note A',
        [SHOPEE_ORDER_COLUMNS.buyerComment]: 'Comment B',
      }),
    ] as ShopeeOrderRawRow[];
    const preview = buildShippingPreviewFromGroup(rows);
    expect(preview.note).toBe('Note A — Comment B');
  });
});

describe('computeOrderMoney', () => {
  it('computes a single-item order with no discount', () => {
    const rows = [baseRow()] as ShopeeOrderRawRow[];
    const money = computeOrderMoney(rows);
    expect(money).toEqual({ subtotal: 17000, shippingFee: 0, discountAmount: 0, total: 17000 });
  });

  it('reconciles a multi-item order with shipping fee and a discount', () => {
    const rows = [
      baseRow({
        [SHOPEE_ORDER_COLUMNS.offerPrice]: '17000.00',
        [SHOPEE_ORDER_COLUMNS.quantity]: '4',
        [SHOPEE_ORDER_COLUMNS.shippingFeePaidByBuyer]: '8000.00',
        [SHOPEE_ORDER_COLUMNS.orderTotalPaid]: '70000.00',
      }),
      baseRow({
        [SHOPEE_ORDER_COLUMNS.offerPrice]: '23000.00',
        [SHOPEE_ORDER_COLUMNS.quantity]: '1',
        [SHOPEE_ORDER_COLUMNS.shippingFeePaidByBuyer]: '8000.00',
        [SHOPEE_ORDER_COLUMNS.orderTotalPaid]: '70000.00',
      }),
    ] as ShopeeOrderRawRow[];
    // subtotal = 17000*4 + 23000*1 = 91000; +shippingFee 8000 = 99000; total paid 70000
    // => discount backed out = 99000 - 70000 = 29000
    const money = computeOrderMoney(rows);
    expect(money.subtotal).toBe(91000);
    expect(money.shippingFee).toBe(8000);
    expect(money.total).toBe(70000);
    expect(money.discountAmount).toBe(29000);
    expect(money.subtotal - money.discountAmount + money.shippingFee).toBe(money.total);
  });

  it('falls back to subtotal + shippingFee when the grand total column is blank', () => {
    const rows = [baseRow({ [SHOPEE_ORDER_COLUMNS.orderTotalPaid]: '' })] as ShopeeOrderRawRow[];
    const money = computeOrderMoney(rows);
    expect(money.total).toBe(17000);
    expect(money.discountAmount).toBe(0);
  });
});

describe('name normalization + matching', () => {
  it('strips Vietnamese diacritics including đ/Đ', () => {
    expect(stripDiacritics('Móc khoá Đủ màu')).toBe('Moc khoa Du mau');
  });

  it('normalizes case, diacritics and punctuation for matching', () => {
    expect(normalizeNameForMatch('Móc khoá Clicker Chocolate Series Đủ màu!')).toBe(
      'moc khoa clicker chocolate series du mau',
    );
  });

  it('unifies "khoá"/"khóa" old vs. new diacritic-placement spelling variants', () => {
    // Stripping the combining accent regardless of which vowel it's attached to
    // happens to unify both accepted Vietnamese spellings of the same word.
    expect(normalizeNameForMatch('móc khoá')).toBe(normalizeNameForMatch('móc khóa'));
  });

  it('jaccardSimilarity is 1 for identical token sets and 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it('findBestProductMatches scores an exact normalized match as 1 and ranks fuzzy matches below it', () => {
    const products = [
      { id: '1', name: 'Móc khoá Clicker Chocolate Series Đủ màu' },
      { id: '2', name: 'Móc khoá Candy Cube Clicker' },
      { id: '3', name: 'Đèn ngủ 3D hoàn toàn không liên quan' },
    ];
    const matches = findBestProductMatches('Móc khoá Clicker Chocolate Series Đủ màu', products);
    expect(matches[0]).toEqual({ productId: '1', name: products[0].name, score: 1 });
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('returns an empty array when there are no products to match against', () => {
    expect(findBestProductMatches('Bất kỳ tên gì', [])).toEqual([]);
  });
});

describe('matchVariantToColorOrSize', () => {
  it('matches an exact color name', () => {
    expect(matchVariantToColorOrSize('Đỏ', [{ name: 'Đỏ' }, { name: 'Xanh' }], [])).toEqual({ color: 'Đỏ' });
  });

  it('matches an exact size label', () => {
    expect(matchVariantToColorOrSize('L', [], ['S', 'M', 'L'])).toEqual({ size: 'L' });
  });

  it('returns {} for a custom/personalization label with no catalog match', () => {
    expect(matchVariantToColorOrSize('1 ô', [{ name: 'Đỏ' }], ['S', 'M'])).toEqual({});
  });

  it('returns {} for a blank label', () => {
    expect(matchVariantToColorOrSize('', [{ name: 'Đỏ' }], [])).toEqual({});
  });
});
