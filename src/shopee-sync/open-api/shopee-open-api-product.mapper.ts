import { MarketplaceImageType } from '../schemas/marketplace-product-image.schema';
import type {
  MarketplaceImageUploadDto,
  MarketplaceProductUploadDto,
  MarketplaceVariantUploadDto,
} from '../dto/marketplace-product-upload.dto';
import { computeEffectivePrice } from '../shopee-sync-diff.util';
import { resolveShopeeImageUrl } from '../shopee-image-resolver';
import type {
  ShopeeItemBaseInfo,
  ShopeeItemExtraInfo,
  ShopeeItemStatus,
  ShopeeModelListResponse,
  ShopeePriceInfo,
  ShopeeStockInfoV2,
} from './shopee-open-api.types';

/**
 * Open API `item_status` → the numeric `rawStatus` the extension (private Seller Center
 * API) stores, so both sources produce identical mirror rows. NORMAL = 1 is confirmed by
 * the real Detail fixture (extension/tests/fixtures/*real.json); the rest are best-effort —
 * `rawStatus` is only displayed/diffed, never drives catalog behaviour.
 */
export const ITEM_STATUS_TO_RAW: Record<ShopeeItemStatus, number> = {
  NORMAL: 1,
  REVIEWING: 2,
  BANNED: 3,
  SELLER_DELETE: 4,
  SHOPEE_DELETE: 5,
  UNLIST: 8,
};

/** Statuses fetched by a FULL sync — the same set Seller Center's "Tất cả" tab lists
 * (the extension uses `list_type=all`). Deleted items are deliberately excluded, so they
 * fall into the existing MISSING → ARCHIVE_CANDIDATE flow. */
export const SYNCABLE_ITEM_STATUSES: ShopeeItemStatus[] = ['NORMAL', 'UNLIST', 'REVIEWING', 'BANNED'];

/** Synthetic id for the single model of a no-variation item (Open API has no model for it;
 * order item_list reports `model_id: 0` for such items). */
export const DEFAULT_MODEL_ID = '0';

/** Private API stores weight as `{ value: "600", unit: 2 }` (grams) — the Open API returns
 * kilograms ("0.6"). Normalized to the private shape so sourceHash doesn't flap. */
const GRAM_WEIGHT_UNIT = 2;

export class ShopeeProductMappingError extends Error {}

export interface MapProductOptions {
  imageUrlTemplate: string;
  videoUrlTemplate: string;
  /** `update_time` from get_item_list — what processListSnapshot() diffed on. */
  listUpdateTime?: number;
  /** Existing mirror default-variant id for a no-variation item (keeps the variant id stable
   * when the product was first synced by the extension). */
  existingDefaultVariantId?: string | null;
}

export function mapShopeeItemToUpload(
  base: ShopeeItemBaseInfo,
  models: ShopeeModelListResponse | null,
  extra: ShopeeItemExtraInfo | null,
  opts: MapProductOptions,
): MarketplaceProductUploadDto {
  if (!base.item_id) throw new ShopeeProductMappingError('Thiếu item_id trong get_item_base_info');
  const name = (base.item_name ?? '').trim();
  if (!name) throw new ShopeeProductMappingError(`Sản phẩm ${base.item_id} thiếu item_name`);

  const imageIds = (base.image?.image_id_list ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const coverImageId = imageIds[0] ?? null;
  const images: MarketplaceImageUploadDto[] = [];
  if (coverImageId) images.push(image(coverImageId, MarketplaceImageType.COVER, 0, opts.imageUrlTemplate));
  imageIds.forEach((id, position) => images.push(image(id, MarketplaceImageType.GALLERY, position, opts.imageUrlTemplate)));

  const tiers = models?.tier_variation ?? [];
  const modelRows = models?.model ?? [];
  const itemPreOrder = !!base.pre_order?.is_pre_order;
  const itemDaysToShip = toNonNegativeInt(base.pre_order?.days_to_ship);

  const variants: MarketplaceVariantUploadDto[] =
    modelRows.length > 0
      ? modelRows.map((m) => {
          if (m.model_id === undefined || m.model_id === null) {
            throw new ShopeeProductMappingError(`Sản phẩm ${base.item_id} có model thiếu model_id`);
          }
          const tierIndexes = (m.tier_index ?? []).filter((i) => Number.isInteger(i));
          const optionNames = tierIndexes.map((idx, t) => tiers[t]?.option_list?.[idx]?.option ?? '').filter(Boolean);
          const imageId = tiers[0]?.option_list?.[tierIndexes[0]]?.image?.image_id || null;
          return variant({
            externalVariantId: String(m.model_id),
            name: optionNames.length ? optionNames.join(',') : null,
            isDefault: false,
            sku: m.model_sku,
            tierIndexes,
            imageId,
            price: m.price_info?.[0],
            stock: m.stock_info_v2,
            preOrder: m.pre_order?.is_pre_order ?? itemPreOrder,
            daysToShip: toNonNegativeInt(m.pre_order?.days_to_ship) ?? itemDaysToShip,
            imageUrlTemplate: opts.imageUrlTemplate,
          });
        })
      : [
          variant({
            externalVariantId: opts.existingDefaultVariantId || DEFAULT_MODEL_ID,
            name: null,
            isDefault: true,
            sku: null,
            tierIndexes: [],
            imageId: null,
            price: base.price_info?.[0],
            stock: base.stock_info_v2,
            preOrder: itemPreOrder,
            daysToShip: itemDaysToShip,
            imageUrlTemplate: opts.imageUrlTemplate,
          }),
        ];

  if (modelRows.length === 0 && base.has_model) {
    throw new ShopeeProductMappingError(`Sản phẩm ${base.item_id} có phân loại (has_model) nhưng get_model_list trả về rỗng`);
  }

  const normalPrices = variants.map((v) => Number(v.normalPrice)).filter(Number.isFinite);
  const effectivePrices = variants.map((v) => Number(v.effectivePrice)).filter(Number.isFinite);
  const kg = Number(base.weight);

  return {
    source: 'SHOPEE',
    externalProductId: String(base.item_id),
    name,
    rawStatus: base.item_status ? ITEM_STATUS_TO_RAW[base.item_status] ?? 0 : 0,
    parentSku: base.item_sku?.trim() || null,
    coverImageId,
    videoId: extractVideoId(base.video_info?.[0]?.video_url, opts.videoUrlTemplate),
    videoUrl: null, // always rebuilt from videoId server-side (hardenProductPayload)
    images,
    description: buildDescription(base),
    descriptionType: base.description_type ?? null,
    categoryIds: base.category_id ? [base.category_id] : [],
    categoryNames: [],
    condition: base.condition === 'NEW' ? 1 : base.condition === 'USED' ? 2 : null,
    brandId: base.brand?.brand_id ? String(base.brand.brand_id) : null,
    brandName: base.brand?.brand_id ? base.brand.original_brand_name ?? null : null,
    priceMin: normalPrices.length ? String(Math.min(...normalPrices)) : '0',
    priceMax: normalPrices.length ? String(Math.max(...normalPrices)) : '0',
    sellingPriceMin: effectivePrices.length ? String(Math.min(...effectivePrices)) : '0',
    sellingPriceMax: effectivePrices.length ? String(Math.max(...effectivePrices)) : '0',
    availableStock: variants.reduce((s, v) => s + v.availableStock, 0),
    sellerStock: variants.reduce((s, v) => s + v.sellerStock, 0),
    shopeeStock: variants.reduce((s, v) => s + v.shopeeStock, 0),
    soldCount: toNonNegativeInt(extra?.sale) ?? 0,
    viewCount: toNonNegativeInt(extra?.views) ?? 0,
    likedCount: toNonNegativeInt(extra?.likes) ?? 0,
    weightValue: Number.isFinite(kg) && kg > 0 ? String(Math.round(kg * 1000)) : null,
    weightUnit: Number.isFinite(kg) && kg > 0 ? GRAM_WEIGHT_UNIT : null,
    dimension: {
      width: positiveString(base.dimension?.package_width),
      length: positiveString(base.dimension?.package_length),
      height: positiveString(base.dimension?.package_height),
    },
    tierVariations: tiers.map((t) => ({ name: t.name ?? '', options: (t.option_list ?? []).map((o) => o.option ?? '') })),
    preOrder: itemPreOrder,
    daysToShip: itemDaysToShip,
    sourceCreatedAt: toNonNegativeInt(base.create_time) ?? 0,
    sourceModifiedAt: toNonNegativeInt(opts.listUpdateTime) ?? toNonNegativeInt(base.update_time) ?? 0,
    variants,
  };
}

/** `video_url` is a full CDN URL; the mirror stores only the path after the configured
 * template prefix (e.g. `https://cvf.shopee.vn/file/` + `<video_id>`). A URL on any other
 * host is dropped rather than stored — videoUrl is always rebuilt from the template. */
export function extractVideoId(videoUrl: string | undefined, videoUrlTemplate: string): string | null {
  if (!videoUrl) return null;
  const prefix = videoUrlTemplate.split('{video_id}')[0];
  if (!prefix || !videoUrl.startsWith(prefix)) return null;
  const id = videoUrl.slice(prefix.length).split(/[?#]/)[0];
  return /^[A-Za-z0-9/._-]+$/.test(id) && id.length <= 500 ? id : null;
}

function buildDescription(base: ShopeeItemBaseInfo): string | null {
  if (base.description_type === 'extended') {
    const text = (base.description_info?.extended_description?.field_list ?? [])
      .filter((f) => f.field_type === 'text' && f.text)
      .map((f) => f.text!.trim())
      .join('\n');
    return text || base.description || null;
  }
  return base.description ?? null;
}

function variant(input: {
  externalVariantId: string;
  name: string | null;
  isDefault: boolean;
  sku: string | null | undefined;
  tierIndexes: number[];
  imageId: string | null;
  price: ShopeePriceInfo | undefined;
  stock: ShopeeStockInfoV2 | undefined;
  preOrder: boolean;
  daysToShip: number | null;
  imageUrlTemplate: string;
}): MarketplaceVariantUploadDto {
  const original = toPrice(input.price?.original_price);
  const current = toPrice(input.price?.current_price);
  // Open API gives original + current (after promotion); the mirror stores normal + promotion
  // price where promotion "0" means none (same as the private API's "0.00").
  const normalPrice = original > 0 ? original : current;
  const promotionPrice = current > 0 && current < normalPrice ? current : 0;
  const normal = String(normalPrice);
  const promo = String(promotionPrice);
  return {
    externalVariantId: input.externalVariantId,
    name: input.name,
    isDefault: input.isDefault,
    sku: input.sku?.trim() || null,
    tierIndexes: input.tierIndexes,
    imageId: input.imageId,
    imageUrl: input.imageId ? resolveShopeeImageUrl(input.imageId, '', input.imageUrlTemplate) : null,
    normalPrice: normal,
    promotionPrice: promo,
    effectivePrice: computeEffectivePrice(normal, promo),
    availableStock: toNonNegativeInt(input.stock?.summary_info?.total_available_stock) ?? 0,
    sellerStock: sumStock(input.stock?.seller_stock),
    shopeeStock: sumStock(input.stock?.shopee_stock),
    reservedStock: toNonNegativeInt(input.stock?.summary_info?.total_reserved_stock) ?? 0,
    soldCount: null,
    availableStatus: null,
    preOrder: input.preOrder,
    daysToShip: input.daysToShip,
  };
}

function image(id: string, imageType: MarketplaceImageType, position: number, template: string): MarketplaceImageUploadDto {
  return { sourceImageId: id, sourceUrl: resolveShopeeImageUrl(id, '', template), imageType, position };
}

function toPrice(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sumStock(list: { stock?: number }[] | undefined): number {
  return (list ?? []).reduce((s, x) => s + (toNonNegativeInt(x.stock) ?? 0), 0);
}

function toNonNegativeInt(v: unknown): number | null {
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function positiveString(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}
