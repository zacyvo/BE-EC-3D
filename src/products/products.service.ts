import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import slugify from 'slugify';
import { Product, ProductDocument, SocialPlatform } from './schemas/product.schema';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { AuditService } from '../audit/audit.service';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';

const CACHE_KEY_LIST = 'products:list';
const CACHE_KEY_DETAIL = (slug: string) => `products:detail:${slug}`;
const CACHE_TTL = 300; // 5 minutes

// Fields hidden from user API (pricing security)
const USER_EXCLUDED_FIELDS = '-costPrice -profit -profitPercent';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly auditService: AuditService,
  ) {}

  /** Guarantees colors/sizes are arrays on the response. Products saved before this
   * feature existed have no such fields in MongoDB, and `.lean()` queries (unlike
   * hydrated Mongoose documents) don't apply schema defaults for missing paths. */
  private withVariantDefaults<T extends { colors?: unknown; sizes?: unknown; socials?: unknown }>(doc: T): T {
    if (doc.colors === undefined) (doc as { colors?: unknown }).colors = [];
    if (doc.sizes === undefined) (doc as { sizes?: unknown }).sizes = [];
    if (doc.socials === undefined) (doc as { socials?: unknown }).socials = [];
    return doc;
  }

  /** Resolve a category value (ObjectId string or slug) → ObjectId, or null if not found */
  private async resolveCategoryId(category: string): Promise<Types.ObjectId | null> {
    if (Types.ObjectId.isValid(category)) return new Types.ObjectId(category);
    const cat = await this.categoryModel.findOne({ slug: category }).select('_id').lean().exec();
    return cat ? (cat._id as Types.ObjectId) : null;
  }

  private computePricing(
    sellingPrice: number,
    costPrice: number,
    discountPercent = 0,
  ) {
    const finalPrice = Math.round(sellingPrice * (1 - discountPercent / 100));
    const profit = finalPrice - costPrice;
    const profitPercent = costPrice > 0 ? Math.round((profit / costPrice) * 100) : 0;
    return { finalPrice, profit, profitPercent };
  }

  /** Trims/drops blank entries and de-dupes by name (case-insensitive), keeping the first occurrence. */
  private sanitizeColors(colors?: CreateProductDto['colors']) {
    if (!colors) return undefined;
    const seen = new Set<string>();
    const cleaned: { name: string; hexCode?: string; images: string[] }[] = [];
    for (const c of colors) {
      const name = c.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        name,
        ...(c.hexCode ? { hexCode: c.hexCode } : {}),
        images: (c.images ?? []).filter(Boolean),
      });
    }
    return cleaned;
  }

  /** Drops entries with neither an id nor a link, and de-dupes by platform, keeping the first occurrence. */
  private sanitizeSocials(socials?: CreateProductDto['socials']) {
    if (!socials) return undefined;
    const seen = new Set<string>();
    const cleaned: { name: SocialPlatform; id?: string; link?: string }[] = [];
    for (const s of socials) {
      const id = s.id?.trim();
      const link = s.link?.trim();
      if (!id && !link) continue;
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      cleaned.push({
        name: s.name,
        ...(id ? { id } : {}),
        ...(link ? { link } : {}),
      });
    }
    return cleaned;
  }

  private sanitizeSizes(sizes?: string[]) {
    if (!sizes) return undefined;
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of sizes) {
      const s = raw?.trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(s);
    }
    return cleaned;
  }

  async create(dto: CreateProductDto, staffId: string): Promise<ProductDocument> {
    let slug = slugify(dto.name, { lower: true, strict: true });
    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) slug = `${slug}-${Date.now()}`;

    const pricing = this.computePricing(
      dto.sellingPrice,
      dto.costPrice,
      dto.discountPercent,
    );

    const product = new this.productModel({
      ...dto,
      colors: this.sanitizeColors(dto.colors) ?? [],
      sizes: this.sanitizeSizes(dto.sizes) ?? [],
      socials: this.sanitizeSocials(dto.socials) ?? [],
      slug,
      category: new Types.ObjectId(dto.category),
      ...pricing,
    });

    const saved = await product.save();
    await this.invalidateCache();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CREATE',
      module: 'products',
      targetId: saved._id.toString(),
      afterData: saved.toObject() as unknown as Record<string, unknown>,
    });

    return saved;
  }

  async findAll(query: {
    page: number;
    limit: number;
    category?: string;
    search?: string;
    forAdmin?: boolean;
    minPrice?: number;
    maxPrice?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const { page, limit, category, search, forAdmin, minPrice, maxPrice, sortBy, sortOrder } = query;

    // Try cache for user queries
    if (!forAdmin && !search && !minPrice && !maxPrice) {
      const cacheKey = `${CACHE_KEY_LIST}:${page}:${limit}:${category || 'all'}`;
      const cached = await this.cacheManager.get<{ data: Array<{ colors?: unknown; sizes?: unknown }> }>(cacheKey);
      if (cached) {
        cached.data.forEach((p) => this.withVariantDefaults(p));
        return cached;
      }
    }

    const filter: Record<string, unknown> = {};
    if (!forAdmin) filter.isActive = true;
    if (category) {
      const categoryId = await this.resolveCategoryId(category);
      if (categoryId) filter.category = categoryId;
      else filter.category = null; // category not found → return empty
    }
    if (search) {
      if (forAdmin) {
        const orConditions: Record<string, unknown>[] = [
          { name: { $regex: search, $options: 'i' } },
        ];
        if (/^[0-9a-f]+$/i.test(search)) {
          orConditions.push({
            $expr: {
              $regexMatch: {
                input: { $toString: '$_id' },
                regex: `${search}$`,
                options: 'i',
              },
            },
          });
        }
        filter.$or = orConditions;
      } else {
        filter.$text = { $search: search };
      }
    }
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.finalPrice = {};
      if (minPrice !== undefined) (filter.finalPrice as any).$gte = minPrice;
      if (maxPrice !== undefined) (filter.finalPrice as any).$lte = maxPrice;
    }

    const selectFields = forAdmin ? '' : USER_EXCLUDED_FIELDS;

    const sortQuery: Record<string, 1 | -1> =
      sortBy === 'finalPrice'
        ? { finalPrice: sortOrder === 'asc' ? 1 : -1 }
        : { createdAt: -1 };

    const [data, total] = await Promise.all([
      this.productModel
        .find(filter)
        .select(selectFields)
        .populate('category', 'name')
        .sort(sortQuery)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.productModel.countDocuments(filter).exec(),
    ]);

    data.forEach((p) => this.withVariantDefaults(p));
    const result = { data, total, page, limit, totalPages: Math.ceil(total / limit) };

    if (!forAdmin && !search && !minPrice && !maxPrice) {
      const cacheKey = `${CACHE_KEY_LIST}:${page}:${limit}:${category || 'all'}`;
      await this.cacheManager.set(cacheKey, result, CACHE_TTL);
    }

    return result;
  }

  async findBySlug(slug: string, forAdmin = false): Promise<ProductDocument> {
    if (!forAdmin) {
      const cached = await this.cacheManager.get<ProductDocument>(CACHE_KEY_DETAIL(slug));
      if (cached) return this.withVariantDefaults(cached);
    }

    const selectFields = forAdmin ? '' : USER_EXCLUDED_FIELDS;
    const product = await this.productModel
      .findOne({ slug })
      .select(selectFields)
      .populate('category', 'name')
      .exec();

    if (!product) throw new NotFoundException('Product not found');
    this.withVariantDefaults(product);

    // Increment view count (non-blocking)
    this.productModel.findByIdAndUpdate(product._id, { $inc: { viewCount: 1 } }).exec();

    if (!forAdmin) {
      await this.cacheManager.set(CACHE_KEY_DETAIL(slug), product, CACHE_TTL);
    }

    return product;
  }

  async findById(id: string, forAdmin = false): Promise<ProductDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Product not found');
    const selectFields = forAdmin ? '' : USER_EXCLUDED_FIELDS;
    const product = await this.productModel.findById(id).select(selectFields).exec();
    if (!product) throw new NotFoundException('Product not found');
    return this.withVariantDefaults(product);
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    staffId: string,
  ): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');

    const before = product.toObject();

    // Recompute pricing if financial fields change
    const sellingPrice = dto.sellingPrice ?? product.sellingPrice;
    const costPrice = dto.costPrice ?? product.costPrice;
    const discountPercent = dto.discountPercent ?? product.discountPercent;
    const pricing = this.computePricing(sellingPrice, costPrice, discountPercent);

    // Regenerate slug if name changed
    let slug = product.slug;
    if (dto.name && dto.name !== product.name) {
      slug = slugify(dto.name, { lower: true, strict: true });
      const existing = await this.productModel.findOne({ slug, _id: { $ne: id } }).exec();
      if (existing) slug = `${slug}-${Date.now()}`;
    }

    const updates = { ...dto, ...pricing, slug };
    if (dto.category) updates.category = new Types.ObjectId(dto.category) as any;
    if (dto.colors !== undefined) updates.colors = this.sanitizeColors(dto.colors) as any;
    if (dto.sizes !== undefined) updates.sizes = this.sanitizeSizes(dto.sizes) as any;
    if (dto.socials !== undefined) updates.socials = this.sanitizeSocials(dto.socials) as any;

    const updated = await this.productModel
      .findByIdAndUpdate(id, { $set: updates }, { new: true })
      .exec();

    if (!updated) throw new NotFoundException('Product not found');

    await this.invalidateCache(product.slug);
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'UPDATE',
      module: 'products',
      targetId: id,
      beforeData: before as unknown as Record<string, unknown>,
      afterData: updated.toObject() as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async softDelete(id: string, staffId: string): Promise<void> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');

    product.isDeleted = true;
    product.deletedAt = new Date();
    product.deletedBy = staffId;
    await product.save();

    await this.invalidateCache(product.slug);
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'DELETE',
      module: 'products',
      targetId: id,
    });
  }

  private async invalidateCache(slug?: string) {
    // Invalidate list cache (all pages)
    const keys = await (this.cacheManager as any).store?.keys?.(`${CACHE_KEY_LIST}:*`);
    if (keys?.length) {
      await Promise.all(keys.map((k: string) => this.cacheManager.del(k)));
    }
    if (slug) {
      await this.cacheManager.del(CACHE_KEY_DETAIL(slug));
    }
  }
}
