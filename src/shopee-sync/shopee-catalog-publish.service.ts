import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductsService } from '../products/products.service';
import { CreateProductDto, ProductColorDto } from '../products/dto/product.dto';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import { MarketplaceProductDocument } from './schemas/marketplace-product.schema';
import { MarketplaceVariantDocument } from './schemas/marketplace-variant.schema';
import { MarketplaceImageType, MarketplaceProductImageDocument } from './schemas/marketplace-product-image.schema';

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

@Injectable()
export class ShopeeCatalogPublishService {
  private readonly logger = new Logger(ShopeeCatalogPublishService.name);
  private uncategorizedIdCache: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    private readonly productsService: ProductsService,
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
   * category/costPrice/isActive on update — those become Admin-owned decisions
   * once the product exists (see docs/shopee-sync-flow.md "Đồng bộ vào catalog thật").
   */
  async publishProduct(
    marketplaceProduct: MarketplaceProductDocument,
    variants: MarketplaceVariantDocument[],
    images: MarketplaceProductImageDocument[],
    staffId: string,
  ): Promise<PublishResult> {
    const externalProductId = marketplaceProduct.externalProductId;
    try {
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

      if (!marketplaceProduct.internalProductId) {
        const categoryId = await this.getOrCreateUncategorizedCategoryId();
        const dto: CreateProductDto = {
          name: marketplaceProduct.name,
          category: categoryId.toString(),
          images: galleryImages,
          colors,
          sizes,
          costPrice: 0,
          sellingPrice,
          discountPercent: 0,
          stock,
          description: marketplaceProduct.description ?? undefined,
          isActive: true,
        };
        const created = await this.productsService.create(dto, staffId);
        marketplaceProduct.internalProductId = created._id as Types.ObjectId;
        await marketplaceProduct.save();
        return { externalProductId, action: 'created', internalProductId: created._id.toString() };
      }

      const updated = await this.productsService
        .update(
          marketplaceProduct.internalProductId.toString(),
          {
            name: marketplaceProduct.name,
            images: galleryImages,
            colors,
            sizes,
            sellingPrice,
            stock,
            description: marketplaceProduct.description ?? undefined,
          },
          staffId,
        )
        .catch(async (err) => {
          // Linked Product was deleted/not found — recreate instead of failing the whole sync.
          this.logger.warn(`internalProductId ${marketplaceProduct.internalProductId} not found for ${externalProductId}, recreating: ${err.message}`);
          marketplaceProduct.internalProductId = null;
          return null;
        });

      if (!updated) {
        marketplaceProduct.internalProductId = null;
        return this.publishProduct(marketplaceProduct, variants, images, staffId);
      }

      return { externalProductId, action: 'updated', internalProductId: updated._id.toString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định khi publish sản phẩm';
      this.logger.error(`Publish thất bại cho product ${externalProductId}: ${message}`);
      return { externalProductId, action: 'skipped', error: message };
    }
  }
}
