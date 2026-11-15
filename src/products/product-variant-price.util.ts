/**
 * Per-variant pricing (giá theo phân loại).
 *
 * A product's options are its `colors` (tier 1) and `sizes` (tier 2). Each combination may
 * carry its own price in `Product.variants`; a combination without an entry sells at the
 * product's own `sellingPrice`/`finalPrice` ("giá chung"). Shopee-synced products get one
 * entry per Shopee model, so every combination is priced explicitly.
 *
 * The product-level `discountPercent` applies to variant prices too, so `finalPrice` is
 * always derived server-side — never trusted from the client.
 */

export interface VariantPriceInput {
  color?: string | null;
  size?: string | null;
  sellingPrice: number;
  sku?: string | null;
}

export interface VariantPrice {
  color?: string;
  size?: string;
  sellingPrice: number;
  finalPrice: number;
  sku?: string;
}

export interface VariantPricedProduct {
  finalPrice: number;
  variants?: { color?: string; size?: string; finalPrice: number }[];
}

export function computeFinalPrice(sellingPrice: number, discountPercent = 0): number {
  return Math.round(sellingPrice * (1 - discountPercent / 100));
}

function clean(v: string | null | undefined): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/** True when the entry is for exactly this color/size selection (no selection = undefined). */
function matches(v: { color?: string; size?: string }, color?: string, size?: string): boolean {
  return (clean(v.color) ?? null) === (clean(color) ?? null) && (clean(v.size) ?? null) === (clean(size) ?? null);
}

export function findVariantPrice<T extends { color?: string; size?: string }>(
  variants: T[] | undefined,
  color?: string,
  size?: string,
): T | undefined {
  return (variants ?? []).find((v) => matches(v, color, size));
}

/** Unit price charged for a selected color/size: the variant's own price when one is set,
 * otherwise the product's price. */
export function resolveUnitPrice(product: VariantPricedProduct, color?: string, size?: string): number {
  return findVariantPrice(product.variants, color, size)?.finalPrice ?? product.finalPrice;
}

/**
 * Keeps only entries that point at an existing option combination: with colors configured the
 * entry must name one of them (and must not name a color when there are none) — same for sizes.
 * An entry naming neither is dropped (that is just the product price). First entry wins on
 * duplicates; finalPrice is recomputed from the product discount.
 */
export function sanitizeVariantPrices(
  variants: VariantPriceInput[] | undefined,
  colorNames: string[],
  sizes: string[],
  discountPercent = 0,
): VariantPrice[] {
  if (!variants?.length) return [];
  const colorSet = new Set(colorNames);
  const sizeSet = new Set(sizes);
  const seen = new Set<string>();
  const out: VariantPrice[] = [];
  for (const v of variants) {
    const color = clean(v.color);
    const size = clean(v.size);
    if (!color && !size) continue;
    if (colorSet.size ? !color || !colorSet.has(color) : !!color) continue;
    if (sizeSet.size ? !size || !sizeSet.has(size) : !!size) continue;
    const sellingPrice = Number(v.sellingPrice);
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) continue;
    const key = `${color ?? ''}\u0000${size ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sku = clean(v.sku);
    out.push({
      ...(color ? { color } : {}),
      ...(size ? { size } : {}),
      sellingPrice: Math.round(sellingPrice),
      finalPrice: computeFinalPrice(Math.round(sellingPrice), discountPercent),
      ...(sku ? { sku } : {}),
    });
  }
  return out;
}
