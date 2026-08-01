/**
 * Pure preview/diff computation — section 15 of the feature spec ("Diff tối
 * thiểu: Name, Status, Description, Category, Price, Stock, Images, Variant
 * added/updated/missing"). Kept DB-free and side-effect-free so it is unit
 * testable without Mongoose; `ShopeeSyncService` supplies plain objects.
 */

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ExistingProductForDiff {
  name: string;
  rawStatus: number;
  description: string | null;
  categoryNames: string[];
  sellingPriceMin: string;
  sellingPriceMax: string;
  availableStock: number;
}

export interface IncomingProductForDiff {
  name: string;
  rawStatus: number;
  description?: string | null;
  categoryNames: string[];
  sellingPriceMin: string;
  sellingPriceMax: string;
  availableStock: number;
}

export function diffProductFields(existing: ExistingProductForDiff, incoming: IncomingProductForDiff): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (field: string, oldValue: unknown, newValue: unknown) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changes.push({ field, oldValue, newValue });
  };
  push('name', existing.name, incoming.name);
  push('status', existing.rawStatus, incoming.rawStatus);
  push('description', existing.description ?? null, incoming.description ?? null);
  push('category', existing.categoryNames, incoming.categoryNames);
  push('priceRange', [existing.sellingPriceMin, existing.sellingPriceMax], [incoming.sellingPriceMin, incoming.sellingPriceMax]);
  push('availableStock', existing.availableStock, incoming.availableStock);
  return changes;
}

export interface ExistingVariantForDiff {
  externalVariantId: string;
  sku: string | null;
  normalPrice: string;
  promotionPrice: string;
  effectivePrice: string;
  availableStock: number;
  imageId: string | null;
  isActive: boolean;
}

export interface IncomingVariantForDiff {
  externalVariantId: string;
  sku: string | null;
  normalPrice: string;
  promotionPrice: string;
  effectivePrice: string;
  availableStock: number;
  imageId: string | null;
}

export interface VariantDiffEntry {
  externalVariantId: string;
  changeType: 'ADDED' | 'UPDATED' | 'MISSING';
  changes: FieldChange[];
}

export function diffVariants(
  existing: ExistingVariantForDiff[],
  incoming: IncomingVariantForDiff[],
): VariantDiffEntry[] {
  const existingById = new Map(existing.filter((v) => v.isActive).map((v) => [v.externalVariantId, v]));
  const incomingById = new Map(incoming.map((v) => [v.externalVariantId, v]));
  const entries: VariantDiffEntry[] = [];

  for (const [id, inc] of incomingById) {
    const prev = existingById.get(id);
    if (!prev) {
      entries.push({ externalVariantId: id, changeType: 'ADDED', changes: [] });
      continue;
    }
    const changes: FieldChange[] = [];
    const push = (field: string, oldValue: unknown, newValue: unknown) => {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changes.push({ field, oldValue, newValue });
    };
    push('sku', prev.sku, inc.sku);
    push('normalPrice', prev.normalPrice, inc.normalPrice);
    push('promotionPrice', prev.promotionPrice, inc.promotionPrice);
    push('effectivePrice', prev.effectivePrice, inc.effectivePrice);
    push('availableStock', prev.availableStock, inc.availableStock);
    push('imageId', prev.imageId, inc.imageId);
    if (changes.length > 0) entries.push({ externalVariantId: id, changeType: 'UPDATED', changes });
  }

  for (const [id] of existingById) {
    if (!incomingById.has(id)) {
      entries.push({ externalVariantId: id, changeType: 'MISSING', changes: [] });
    }
  }

  return entries;
}

export function diffImageIds(existingActiveImageIds: string[], incomingImageIds: string[]): { added: string[]; removed: string[] } {
  const existingSet = new Set(existingActiveImageIds);
  const incomingSet = new Set(incomingImageIds);
  return {
    added: incomingImageIds.filter((id) => !existingSet.has(id)),
    removed: existingActiveImageIds.filter((id) => !incomingSet.has(id)),
  };
}
