import { HttpStatus } from '@nestjs/common';
import { MarketplaceProductSyncStatus } from './schemas/marketplace-product.schema';
import { ShopeeSyncItemStatus } from './schemas/shopee-sync-item.schema';
import {
  assertSnapshotIntegrity,
  computeEffectivePrice,
  computeSourceHash,
  decideProductIndexStatus,
  nextSyncStatusWhenMissing,
} from './shopee-sync-diff.util';
import { ShopeeSyncException } from './shopee-sync.exceptions';
import { ShopeeSyncErrorCode } from './shopee-sync.constants';

describe('decideProductIndexStatus', () => {
  it('marks an unseen product as NEW (test #13)', () => {
    expect(decideProductIndexStatus(null, 1_700_000_000, false)).toBe(ShopeeSyncItemStatus.NEW);
  });

  it('marks a product CHANGED when modifyTime differs from the stored value (test #14)', () => {
    const existing = { sourceModifiedAt: 100, lastDetailSyncFailed: false, syncStatus: MarketplaceProductSyncStatus.ACTIVE };
    expect(decideProductIndexStatus(existing, 200, false)).toBe(ShopeeSyncItemStatus.CHANGED);
  });

  it('marks a product UNCHANGED when modifyTime is identical and nothing else forces a re-sync (test #15)', () => {
    const existing = { sourceModifiedAt: 100, lastDetailSyncFailed: false, syncStatus: MarketplaceProductSyncStatus.ACTIVE };
    expect(decideProductIndexStatus(existing, 100, false)).toBe(ShopeeSyncItemStatus.UNCHANGED);
  });

  it('forces CHANGED for every existing product when forceFullSync is true (test #16)', () => {
    const existing = { sourceModifiedAt: 100, lastDetailSyncFailed: false, syncStatus: MarketplaceProductSyncStatus.ACTIVE };
    expect(decideProductIndexStatus(existing, 100, true)).toBe(ShopeeSyncItemStatus.CHANGED);
  });

  it('retries a product whose previous Detail sync failed, even if modifyTime is unchanged', () => {
    const existing = { sourceModifiedAt: 100, lastDetailSyncFailed: true, syncStatus: MarketplaceProductSyncStatus.ACTIVE };
    expect(decideProductIndexStatus(existing, 100, false)).toBe(ShopeeSyncItemStatus.CHANGED);
  });
});

describe('computeEffectivePrice', () => {
  it('uses normalPrice when promotionPrice is 0 (test #18)', () => {
    expect(computeEffectivePrice('100000', '0')).toBe('100000');
  });

  it('uses promotionPrice when it is greater than 0, without mutating normalPrice (test #19)', () => {
    expect(computeEffectivePrice('100000', '79000')).toBe('79000');
  });

  it('never lets a non-finite/garbage promotionPrice win', () => {
    expect(computeEffectivePrice('100000', 'not-a-number')).toBe('100000');
  });
});

describe('computeSourceHash', () => {
  it('is stable regardless of key order', () => {
    const a = computeSourceHash({ name: 'A', price: '10' });
    const b = computeSourceHash({ price: '10', name: 'A' });
    expect(a).toBe(b);
  });

  it('changes when a value changes', () => {
    const a = computeSourceHash({ name: 'A' });
    const b = computeSourceHash({ name: 'B' });
    expect(a).not.toBe(b);
  });
});

describe('nextSyncStatusWhenMissing (test #25 — never hard delete)', () => {
  it('flags a first miss as MISSING_ONCE', () => {
    expect(nextSyncStatusWhenMissing(MarketplaceProductSyncStatus.ACTIVE)).toBe(MarketplaceProductSyncStatus.MISSING_ONCE);
  });

  it('escalates a second consecutive miss to ARCHIVE_CANDIDATE, never a delete outcome', () => {
    expect(nextSyncStatusWhenMissing(MarketplaceProductSyncStatus.MISSING_ONCE)).toBe(
      MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE,
    );
  });

  it('keeps an already-archive-candidate product as ARCHIVE_CANDIDATE (idempotent)', () => {
    expect(nextSyncStatusWhenMissing(MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE)).toBe(
      MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE,
    );
  });
});

describe('assertSnapshotIntegrity (test #5, #8)', () => {
  it('passes when unique product count matches the declared total', () => {
    expect(() => assertSnapshotIntegrity([{ externalProductId: '1' }, { externalProductId: '2' }], 2)).not.toThrow();
  });

  it('throws SNAPSHOT_DUPLICATE_PRODUCT on a duplicate externalProductId (test #5)', () => {
    try {
      assertSnapshotIntegrity([{ externalProductId: '1' }, { externalProductId: '1' }], 2);
      fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ShopeeSyncException);
      expect((err as ShopeeSyncException).errorCode).toBe(ShopeeSyncErrorCode.SNAPSHOT_DUPLICATE_PRODUCT);
      expect((err as ShopeeSyncException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('throws SNAPSHOT_TOTAL_MISMATCH when unique count differs from declared total (test #8)', () => {
    try {
      assertSnapshotIntegrity([{ externalProductId: '1' }, { externalProductId: '2' }], 3);
      fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ShopeeSyncException);
      expect((err as ShopeeSyncException).errorCode).toBe(ShopeeSyncErrorCode.SNAPSHOT_TOTAL_MISMATCH);
    }
  });
});
