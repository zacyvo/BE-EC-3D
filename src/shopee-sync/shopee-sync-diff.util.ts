import { createHash } from 'crypto';
import { HttpStatus } from '@nestjs/common';
import { MarketplaceProductSyncStatus } from './schemas/marketplace-product.schema';
import { ShopeeSyncItemStatus } from './schemas/shopee-sync-item.schema';
import { ShopeeSyncErrorCode } from './shopee-sync.constants';
import { ShopeeSyncException } from './shopee-sync.exceptions';

/**
 * Pure, DB-free diffing rules — kept separate from `ShopeeSyncService` so the
 * exact decision table (section 7/14/15 of the feature spec) is unit-testable
 * without spinning up Mongoose/Nest.
 */

export interface ExistingProductSnapshot {
  sourceModifiedAt: number;
  lastDetailSyncFailed: boolean;
  syncStatus: MarketplaceProductSyncStatus;
}

/** Decides whether a product seen in the List snapshot needs a Detail call. */
export function decideProductIndexStatus(
  existing: ExistingProductSnapshot | null,
  incomingModifyTime: number,
  forceFullSync: boolean,
): ShopeeSyncItemStatus.NEW | ShopeeSyncItemStatus.CHANGED | ShopeeSyncItemStatus.UNCHANGED {
  if (!existing) return ShopeeSyncItemStatus.NEW;
  if (forceFullSync) return ShopeeSyncItemStatus.CHANGED;
  if (existing.lastDetailSyncFailed) return ShopeeSyncItemStatus.CHANGED;
  if (existing.sourceModifiedAt !== incomingModifyTime) return ShopeeSyncItemStatus.CHANGED;
  return ShopeeSyncItemStatus.UNCHANGED;
}

/**
 * Decides NEW/CHANGED for a MANUAL sync (admin-supplied product_id, no List phase).
 *
 * Deliberately does NOT reuse `decideProductIndexStatus`'s modify-time comparison:
 * manually-synced items have no List `modify_time` (Detail API doesn't expose it),
 * so `sourceModifiedAt` is persisted as the sentinel `0`. Comparing `0 !== 0` on a
 * *second* manual sync of the same product would wrongly evaluate to UNCHANGED and
 * silently skip the refresh the admin explicitly asked for. A manual sync always
 * means "go fetch this product now", so it is always NEW or CHANGED, never UNCHANGED.
 */
export function decideManualSyncStatus(
  alreadyExists: boolean,
): ShopeeSyncItemStatus.NEW | ShopeeSyncItemStatus.CHANGED {
  return alreadyExists ? ShopeeSyncItemStatus.CHANGED : ShopeeSyncItemStatus.NEW;
}

/** Section 14: promotionPrice never overwrites normalPrice; effectivePrice is derived. */
export function computeEffectivePrice(normalPrice: string, promotionPrice: string): string {
  const promo = Number(promotionPrice);
  return Number.isFinite(promo) && promo > 0 ? promotionPrice : normalPrice;
}

/** Extra change-detection safety net alongside `sourceModifiedAt` — stable key order. */
export function computeSourceHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Section 15: first miss = MISSING_ONCE, a second consecutive full-sync miss = ARCHIVE_CANDIDATE. Never returns a "delete" outcome. */
export function nextSyncStatusWhenMissing(
  current: MarketplaceProductSyncStatus,
): MarketplaceProductSyncStatus.MISSING_ONCE | MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE {
  if (
    current === MarketplaceProductSyncStatus.MISSING_ONCE ||
    current === MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE
  ) {
    return MarketplaceProductSyncStatus.ARCHIVE_CANDIDATE;
  }
  return MarketplaceProductSyncStatus.MISSING_ONCE;
}

/** Section 4/10/15: total count + duplicate validation, independent of the extension's own checks. */
export function assertSnapshotIntegrity(items: Array<{ externalProductId: string }>, declaredTotal: number): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.externalProductId)) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SNAPSHOT_DUPLICATE_PRODUCT,
        `Product trùng lặp trong snapshot: ${item.externalProductId}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    seen.add(item.externalProductId);
  }
  if (seen.size !== declaredTotal) {
    throw new ShopeeSyncException(
      ShopeeSyncErrorCode.SNAPSHOT_TOTAL_MISMATCH,
      `Số lượng product duy nhất (${seen.size}) khác total khai báo (${declaredTotal})`,
      HttpStatus.BAD_REQUEST,
    );
  }
}
