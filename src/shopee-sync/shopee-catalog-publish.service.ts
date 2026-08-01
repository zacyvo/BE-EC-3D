import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductsService } from '../products/products.service';
import { CreateProductDto, ProductColorDto, ProductSocialDto, UpdateProductDto } from '../products/dto/product.dto';
import { SocialPlatform } from '../products/schemas/product.schema';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import { MarketplaceProductDocument } from './schemas/marketplace-product.schema';
import { MarketplaceVariantDocument } from './schemas/marketplace-variant.schema';
import { MarketplaceImageType, MarketplaceProductImageDocument } from './schemas/marketplace-product-image.schema';
import { ShopeeSyncConfigService } from './shopee-sync.config';

const UNCATEGORIZED_SLUG = 'chua-phan-loai';
const UNCATEGORIZED_NAME = 'Chưa phân loại';

export interface PublishResult {
  externalProductId: string;
  action: 'created' | 'updated' | 'skipped';
  internalProductId?: string;
  error?: string;
}

/** Pure mapping: Shopee's tier dimensions → Luxe Glow's simple colors/sizes.
 * Tier 1 → colors (name + one representative image per option, via any variant
 * whose tierIndexes[0] matches); tier 2 (if present) → sizes (plain names, Product
 * has no per-size price/stock). Never maps by option NAME — always by index,
 * matching how Shopee itself relates variants to tier options. */
export function buildColorsAndSizes(
  tierVariations: { name: string; options: string[] }[],
  variants: { tierIndexes: number[]; imageUrl: string | null }[],
): { colors: ProductColorDto[]; sizes: string[] } {
  const colorTier = tierVariations[0];
  const sizeTier = tierVariations[1];

  const colors: ProductColorDto[] = colorTier
    ? colorTier.options.map((name, optionIndex) => {
        const match = variants.find((v) => v.tierIndexes[0] === optionIndex && v.imageUrl);
        return { name, images: match?.imageUrl ? [match.imageUrl] : [] };
      })
    : [];

  const sizes = sizeTier ? sizeTier.options.filter((s) => s.trim().length > 0) : [];

  return { colors, sizes };
}

/** Builds the Shopee entry for `Product.socials` — link format is configurable
 * (`SHOPEE_SYNC_PRODUCT_URL_TEMPLATE`), not verified against a real shop. */
export function buildShopeeSocialLink(shopId: string, externalProductId: string, template: string): string {
  return template.replace('{shop_id}', encodeURIComponent(shopId)).replace('{product_id}', encodeURIComponent(externalProductId));
}

/** Replaces any existing SHOPEE entry with the fresh one, leaving every other
 * platform (Facebook, TikTok, manually-added...) untouched — `ProductsService`
 * itself has no merge semantics, `socials` is a full-array replace on update. */
export function mergeShopeeSocial(existingSocials: ProductSocialDto[], shopeeSocial: ProductSocialDto): ProductSocialDto[] {
  return [...existingSocials.filter((s) => s.name !== SocialPlatform.SHOPEE), shopeeSocial];
}

@Injectable()
export class ShopeeCatalogPublishService {
  private readonly logger = new Logger(ShopeeCatalogPublishService.name);
  private uncategorizedIdCache: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    private readonly productsService: ProductsService,
    private readonly configService: ShopeeSyncConfigService,
  ) {}

  private async getOrCreateUncategorizedCategoryId(): Promise<Types.ObjectId> {
    if (this.uncategorizedIdCache) return this.uncategorizedIdCache;
    const category = await this.categoryModel
      .findOneAndUpdate(
        { slug: UNCATEGORIZED_SLUG },
        { $setOnInsert: { name: UNCATEGORIZED_NAME, slug: UNCATEGORIZED_SLUG, isActive: true } },
        { upsert: true, new: true },
      )
      .exec();
    this.uncategorizedIdCache = category._id as Types.ObjectId;
    return this.uncategorizedIdCache;
  }

  /**
   * Creates (first sync) or updates (later syncs) the real catalog `Product` for
   * one synced Shopee product, reusing `ProductsService` so pricing/slug/audit-log
   * rules stay identical to a manually-created product. Never touches
   * category/costPrice on update — those become Admin-owned decisions once the
   * product exists (see docs/shopee-sync-flow.md "Đồng bộ vào catalog thật").
   *
   * `isActive`: forced to `false` whenever `sellingPrice <= 0` (broken/incomplete
   * price data must never go live for sale); never force-reactivates a product an
   * Admin deliberately deactivated for other reasons once price data is healthy.
   */
  async publishProduct(
    marketplaceProduct: MarketplaceProductDocument,
    variants: MarketplaceVariantDocument[],
    images: MarketplaceProductImageDocument[],
    staffId: string,
  ): Promise<PublishResult> {
    const externalProductId = marketplaceProduct.externalProductId;
    try {
      const cfg = this.configService.get();
      const activeVariants = variants.filter((v) => v.isActive);
      const { colors, sizes } = buildColorsAndSizes(
        marketplaceProduct.tierVariations,
        activeVariants.map((v) => ({ tierIndexes: v.tierIndexes, imageUrl: v.imageUrl })),
      );
      const galleryImages = images
        .filter((img) => img.isActive && img.imageType !== MarketplaceImageType.VARIANT)
        .sort((a, b) => a.position - b.position)
        .map((img) => img.sourceUrl);
      const sellingPrice = Number(marketplaceProduct.sellingPriceMin) || 0;
      const stock = marketplaceProduct.availableStock;
      const isActive = sellingPrice > 0;
      const shopeeSocial: ProductSocialDto = {
        name: SocialPlatform.SHOPEE,
        id: externalProductId,
        link: buildShopeeSocialLink(marketplaceProduct.shopId, externalProductId, cfg.productUrlTemplate),
      };

      if (!marketplaceProduct.internalProductId) {
        const categoryId = await this.getOrCreateUncategorizedCategoryId();
        const dto: CreateProductDto = {
          name: marketplaceProduct.name,
          category: categoryId.toString(),
          images: galleryImages,
          video: marketplaceProduct.videoUrl ?? undefined,
          colors,
          sizes,
          socials: [shopeeSocial],
          costPrice: 0,
          sellingPrice,
          discountPercent: 0,
          stock,
          description: marketplaceProduct.description ?? undefined,
          isActive,
        };
        const created = await this.productsService.create(dto, staffId);
        marketplaceProduct.internalProductId = created._id as Types.ObjectId;
        await marketplaceProduct.save();
        return { externalProductId, action: 'created', internalProductId: created._id.toString() };
      }

      const existing = await this.productsService.findById(marketplaceProduct.internalProductId.toString(), true).catch(() => null);
      if (!existing) {
        this.logger.warn(`internalProductId ${marketplaceProduct.internalProductId} không còn tồn tại cho ${externalProductId}, tạo lại.`);
        marketplaceProduct.internalProductId = null;
        return this.publishProduct(marketplaceProduct, variants, images, staffId);
      }

      const updateDto: UpdateProductDto = {
        name: marketplaceProduct.name,
        images: galleryImages,
        video: marketplaceProduct.videoUrl ?? undefined,
        colors,
        sizes,
        socials: mergeShopeeSocial(existing.socials ?? [], shopeeSocial),
        sellingPrice,
        stock,
        description: marketplaceProduct.description ?? undefined,
      };
      if (!isActive) updateDto.isActive = false;

      const updated = await this.productsService.update(marketplaceProduct.internalProductId.toString(), updateDto, staffId);
      return { externalProductId, action: 'updated', internalProductId: updated._id.toString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định khi publish sản phẩm';
      this.logger.error(`Publish thất bại cho product ${externalProductId}: ${message}`);
      return { externalProductId, action: 'skipped', error: message };
    }
  }
}

