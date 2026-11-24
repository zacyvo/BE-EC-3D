import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Banner, BannerDocument } from './schemas/banner.schema';
import { CreateBannerDto, ReorderBannersDto, UpdateBannerDto } from './dto/banner.dto';
import {
  BannerLinkType, BannerPlacement, BannerStatus, EXTERNAL_URL_REGEX, INTERNAL_PATH_REGEX,
  MAX_PUBLIC_BANNERS_PER_PLACEMENT,
} from './banner.constants';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { AuditService } from '../audit/audit.service';

/** Dữ liệu trang chủ cần — không lộ clickCount / người tạo. */
export interface PublicBanner {
  _id: string;
  placement: BannerPlacement;
  title: string;
  altText: string;
  imageDesktop: string;
  imageMobile: string;
  /** null = banner không bấm được. */
  href: string | null;
  isExternal: boolean;
  openInNewTab: boolean;
  startAt: Date | null;
  endAt: Date | null;
}

export type AdminBanner = Record<string, unknown> & { status: BannerStatus };

export interface AdminBannerList {
  items: AdminBanner[];
  /** Số banner đang hiển thị trên trang chủ theo từng vị trí. */
  runningCounts: Record<BannerPlacement, number>;
  serverTime: Date;
}

type LinkFields = Pick<Banner, 'linkType' | 'linkUrl' | 'productId' | 'openInNewTab'>;

export function bannerStatus(
  b: Pick<Banner, 'isActive' | 'startAt' | 'endAt'>,
  now: Date = new Date(),
): BannerStatus {
  if (!b.isActive) return 'INACTIVE';
  if (b.endAt && b.endAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (b.startAt && b.startAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'RUNNING';
}

/** Điều kiện "đang chạy" tại thời điểm now — dùng chung cho trang chủ và thống kê admin. */
export function runningFilter(now: Date): FilterQuery<BannerDocument> {
  return {
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gt: now } }] },
    ],
  };
}

@Injectable()
export class BannersService {
  constructor(
    @InjectModel(Banner.name) private readonly bannerModel: Model<BannerDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    private readonly auditService: AuditService,
  ) {}

  // ─── Public ────────────────────────────────────────────────────────────────

  async findPublic(placement?: BannerPlacement, now: Date = new Date()): Promise<PublicBanner[]> {
    const placements = placement ? [placement] : Object.values(BannerPlacement);
    const groups = await Promise.all(
      placements.map((p) =>
        this.bannerModel
          .find({ placement: p, ...runningFilter(now) })
          .sort({ sortOrder: 1, createdAt: -1 })
          .limit(MAX_PUBLIC_BANNERS_PER_PLACEMENT)
          .lean<Banner[]>()
          .exec(),
      ),
    );
    const banners = groups.flat();

    const productIds = banners
      .filter((b) => b.linkType === BannerLinkType.PRODUCT && b.productId)
      .map((b) => b.productId as Types.ObjectId);
    const products = productIds.length
      ? await this.productModel
          .find({ _id: { $in: productIds }, isActive: true })
          .select('slug')
          .lean<{ _id: Types.ObjectId; slug: string }[]>()
          .exec()
      : [];
    const slugById = new Map(products.map((p) => [p._id.toString(), p.slug]));

    return banners.map((b) => {
      const { href, isExternal } = this.resolveHref(b, slugById);
      return {
        _id: b._id.toString(),
        placement: b.placement,
        title: b.title,
        altText: b.altText || b.title,
        imageDesktop: b.imageDesktop,
        imageMobile: b.imageMobile || '',
        href,
        isExternal,
        openInNewTab: href ? b.openInNewTab : false,
        startAt: b.startAt ?? null,
        endAt: b.endAt ?? null,
      };
    });
  }

  /** Đếm lượt bấm — id không tồn tại thì bỏ qua lặng lẽ (không để lộ thông tin). */
  async trackClick(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await this.bannerModel.updateOne({ _id: id }, { $inc: { clickCount: 1 } }).exec();
  }

  private resolveHref(b: LinkFields, slugById: Map<string, string>): { href: string | null; isExternal: boolean } {
    switch (b.linkType) {
      case BannerLinkType.PRODUCT: {
        const slug = b.productId ? slugById.get(b.productId.toString()) : undefined;
        // Sản phẩm đã ẩn/xoá: đưa khách sang danh sách sản phẩm thay vì trang 404.
        return { href: slug ? `/products/${slug}` : '/products', isExternal: false };
      }
      case BannerLinkType.INTERNAL:
        return { href: b.linkUrl || null, isExternal: false };
      case BannerLinkType.EXTERNAL:
        return { href: b.linkUrl || null, isExternal: !!b.linkUrl };
      default:
        return { href: null, isExternal: false };
    }
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  async findAllAdmin(placement?: BannerPlacement): Promise<AdminBannerList> {
    const now = new Date();
    const filter: FilterQuery<BannerDocument> = placement ? { placement } : {};
    const banners = await this.bannerModel
      .find(filter)
      .sort({ placement: 1, sortOrder: 1, createdAt: -1 })
      .populate('productId', 'name slug images isActive')
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name')
      .lean<Record<string, unknown>[]>()
      .exec();

    const runningCounts = Object.fromEntries(
      await Promise.all(
        Object.values(BannerPlacement).map(async (p) => [
          p,
          await this.bannerModel.countDocuments({ placement: p, ...runningFilter(now) }).exec(),
        ]),
      ),
    ) as Record<BannerPlacement, number>;

    return {
      items: banners.map((b) => ({ ...b, status: bannerStatus(b as unknown as Banner, now) })),
      runningCounts,
      serverTime: now,
    };
  }

  async findOneAdmin(id: string): Promise<AdminBanner> {
    const banner = await this.bannerModel
      .findById(this.assertId(id))
      .populate('productId', 'name slug images isActive')
      .lean<Record<string, unknown>>()
      .exec();
    if (!banner) throw new NotFoundException('Không tìm thấy banner');
    return { ...banner, status: bannerStatus(banner as unknown as Banner) };
  }

  async create(dto: CreateBannerDto, staffId: string): Promise<BannerDocument> {
    const data = await this.normalize(dto as Partial<Banner> & { productId?: string | null });
    this.assertSchedule(data.startAt ?? null, data.endAt ?? null);

    // Banner mới mặc định xếp cuối slider của vị trí đó.
    if (dto.sortOrder === undefined) {
      const last = await this.bannerModel
        .findOne({ placement: dto.placement })
        .sort({ sortOrder: -1 })
        .select('sortOrder')
        .lean<{ sortOrder: number }>()
        .exec();
      data.sortOrder = last ? last.sortOrder + 1 : 0;
    }

    const banner = await this.bannerModel.create({
      ...data,
      createdBy: new Types.ObjectId(staffId),
      updatedBy: new Types.ObjectId(staffId),
    });

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'BANNER_CREATE',
      module: 'banners',
      targetId: banner._id.toString(),
      afterData: this.auditSnapshot(banner),
    });
    return banner;
  }

  async update(id: string, dto: UpdateBannerDto, staffId: string): Promise<BannerDocument> {
    const banner = await this.bannerModel.findById(this.assertId(id)).exec();
    if (!banner) throw new NotFoundException('Không tìm thấy banner');
    const before = this.auditSnapshot(banner);

    const merged = {
      linkType: dto.linkType ?? banner.linkType,
      linkUrl: dto.linkUrl ?? banner.linkUrl,
      productId:
        dto.productId !== undefined ? dto.productId : banner.productId ? banner.productId.toString() : null,
      openInNewTab: dto.openInNewTab ?? banner.openInNewTab,
      startAt: dto.startAt !== undefined ? dto.startAt : banner.startAt,
      endAt: dto.endAt !== undefined ? dto.endAt : banner.endAt,
    };
    const data = await this.normalize({ ...dto, ...merged });
    this.assertSchedule(data.startAt ?? null, data.endAt ?? null);

    banner.set({ ...data, updatedBy: new Types.ObjectId(staffId) });
    await banner.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'BANNER_UPDATE',
      module: 'banners',
      targetId: banner._id.toString(),
      beforeData: before,
      afterData: this.auditSnapshot(banner),
    });
    return banner;
  }

  async remove(id: string, staffId: string): Promise<{ deleted: true }> {
    const banner = await this.bannerModel.findById(this.assertId(id)).exec();
    if (!banner) throw new NotFoundException('Không tìm thấy banner');
    await banner.deleteOne();
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'BANNER_DELETE',
      module: 'banners',
      targetId: id,
      beforeData: this.auditSnapshot(banner),
    });
    return { deleted: true };
  }

  /** ids theo thứ tự mới; banner cùng vị trí không có trong danh sách giữ nguyên, xếp sau. */
  async reorder(dto: ReorderBannersDto, staffId: string): Promise<AdminBannerList> {
    const unique = [...new Set(dto.ids)];
    const found = await this.bannerModel
      .countDocuments({ _id: { $in: unique }, placement: dto.placement })
      .exec();
    if (found !== unique.length) {
      throw new BadRequestException('Danh sách banner không hợp lệ hoặc không cùng vị trí');
    }
    await this.bannerModel.bulkWrite(
      unique.map((id, index) => ({
        updateOne: { filter: { _id: new Types.ObjectId(id) }, update: { $set: { sortOrder: index } } },
      })),
    );
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'BANNER_REORDER',
      module: 'banners',
      afterData: { placement: dto.placement, ids: unique },
    });
    return this.findAllAdmin(dto.placement);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Chuẩn hoá liên kết theo linkType + kiểm tra sản phẩm tồn tại. */
  private async normalize<T extends Partial<Omit<Banner, 'productId'>> & { productId?: string | Types.ObjectId | null }>(
    input: T,
  ): Promise<Partial<Banner>> {
    const out: Partial<Banner> & Record<string, unknown> = { ...(input as Record<string, unknown>) };
    if (typeof out.imageMobile === 'string') out.imageMobile = out.imageMobile.trim();
    if (out.linkType === undefined) return out as Partial<Banner>;

    const url = (input.linkUrl ?? '').trim();
    switch (input.linkType) {
      case BannerLinkType.NONE:
        Object.assign(out, { linkUrl: '', productId: null, openInNewTab: false });
        break;
      case BannerLinkType.PRODUCT: {
        const pid = input.productId ? input.productId.toString() : '';
        if (!Types.ObjectId.isValid(pid)) throw new BadRequestException('Vui lòng chọn sản phẩm liên kết');
        const exists = await this.productModel.exists({ _id: pid }).exec();
        if (!exists) throw new BadRequestException('Sản phẩm liên kết không tồn tại');
        Object.assign(out, { linkUrl: '', productId: new Types.ObjectId(pid) });
        break;
      }
      case BannerLinkType.INTERNAL:
        if (!INTERNAL_PATH_REGEX.test(url)) {
          throw new BadRequestException('Đường dẫn trong website phải bắt đầu bằng "/" (VD: /custom-order)');
        }
        Object.assign(out, { linkUrl: url, productId: null });
        break;
      case BannerLinkType.EXTERNAL:
        if (!EXTERNAL_URL_REGEX.test(url)) {
          throw new BadRequestException('Liên kết ngoài phải bắt đầu bằng https://, http://, tel: hoặc mailto:');
        }
        Object.assign(out, { linkUrl: url, productId: null });
        break;
    }
    return out as Partial<Banner>;
  }

  private assertSchedule(startAt: Date | null, endAt: Date | null) {
    if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('Thời gian kết thúc phải sau thời gian bắt đầu');
    }
  }

  private assertId(id: string): string {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Không tìm thấy banner');
    return id;
  }

  private auditSnapshot(b: BannerDocument) {
    return {
      placement: b.placement,
      title: b.title,
      imageDesktop: b.imageDesktop,
      imageMobile: b.imageMobile,
      linkType: b.linkType,
      linkUrl: b.linkUrl,
      productId: b.productId?.toString() ?? null,
      openInNewTab: b.openInNewTab,
      isActive: b.isActive,
      startAt: b.startAt,
      endAt: b.endAt,
      sortOrder: b.sortOrder,
    };
  }
}
