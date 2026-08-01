import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import {
  MarketplaceChannel,
  MarketplaceProduct,
  MarketplaceProductDocument,
  MarketplaceProductSyncStatus,
} from './schemas/marketplace-product.schema';
import { MarketplaceImageType, MarketplaceProductImage, MarketplaceProductImageDocument } from './schemas/marketplace-product-image.schema';
import { MarketplaceVariant, MarketplaceVariantDocument } from './schemas/marketplace-variant.schema';
import { ShopeeSyncItem, ShopeeSyncItemDocument, ShopeeSyncItemStatus } from './schemas/shopee-sync-item.schema';
import { ShopeeSyncMode, ShopeeSyncSession, ShopeeSyncSessionDocument, ShopeeSyncSessionStatus } from './schemas/shopee-sync-session.schema';
import { CreateManualSyncSessionDto, CreateSyncSessionDto } from './dto/create-sync-session.dto';
import { ListSnapshotDto } from './dto/list-snapshot.dto';
import { MarketplaceProductUploadDto, UploadProductDetailDto } from './dto/marketplace-product-upload.dto';
import { ShopeeSyncConfigService, ShopeeSyncConfigSnapshot } from './shopee-sync.config';
import { ShopeeSyncErrorCode, SHOPEE_SYNC_AUDIT_MODULE } from './shopee-sync.constants';
import { ShopeeSyncException } from './shopee-sync.exceptions';
import { generateUploadToken } from './shopee-sync-token.util';
import {
  assertSnapshotIntegrity,
  computeEffectivePrice,
  computeSourceHash,
  decideManualSyncStatus,
  decideProductIndexStatus,
  nextSyncStatusWhenMissing,
} from './shopee-sync-diff.util';
import { resolveShopeeImageUrl } from './shopee-image-resolver';
import { resolveShopeeVideoUrl } from './shopee-video-resolver';
import { diffImageIds, diffProductFields, diffVariants } from './shopee-sync-preview.util';
import { ShopeeCatalogPublishService } from './shopee-catalog-publish.service';

export interface CreateSessionResult {
  id: string;
  uploadToken: string;
  expiresAt: string;
  shopId: string;
  config: { pageSize: number; maxPages: number; maxProducts: number; adapterVersion: string; imageUrlTemplate: string };
}

export interface CreateManualSessionResult extends CreateSessionResult {
  /** Same list the admin submitted, deduped — the extension fetches Detail for exactly these ids. */
  detailProductIds: string[];
}

@Injectable()
export class ShopeeSyncService {
  constructor(
    @InjectModel(ShopeeSyncSession.name) private readonly sessionModel: Model<ShopeeSyncSessionDocument>,
    @InjectModel(ShopeeSyncItem.name) private readonly itemModel: Model<ShopeeSyncItemDocument>,
    @InjectModel(MarketplaceProduct.name) private readonly productModel: Model<MarketplaceProductDocument>,
    @InjectModel(MarketplaceVariant.name) private readonly variantModel: Model<MarketplaceVariantDocument>,
    @InjectModel(MarketplaceProductImage.name) private readonly imageModel: Model<MarketplaceProductImageDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ShopeeSyncConfigService,
    private readonly auditService: AuditService,
    private readonly catalogPublishService: ShopeeCatalogPublishService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────────────

  getConfig() {
    return this.configService.get();
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  /** Shared kill-switch + minimum-extension-version gate for both FULL and MANUAL session creation. */
  private assertSyncAllowed(extensionVersion: string): ShopeeSyncConfigSnapshot {
    const cfg = this.configService.get();

    if (!cfg.enabled) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_SYNC_DISABLED,
        'Tạm dừng đồng bộ Shopee vì cấu trúc Seller Center đã thay đổi. Dữ liệu hiện tại trong Luxe Glow không bị ảnh hưởng.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (!this.configService.isExtensionVersionSupported(extensionVersion)) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_SYNC_EXTENSION_OUTDATED,
        `Vui lòng cập nhật Chrome Extension lên phiên bản tối thiểu ${cfg.minimumExtensionVersion}`,
        426, // Upgrade Required — not present in this @nestjs/common version's HttpStatus enum
      );
    }

    return cfg;
  }

  async createSession(dto: CreateSyncSessionDto, adminId: string, isSuperAdmin: boolean): Promise<CreateSessionResult> {
    const cfg = this.assertSyncAllowed(dto.extensionVersion);

    if (dto.forceFullSync && !isSuperAdmin) {
      throw new ForbiddenException('Chỉ Super Admin được chọn Force Full Sync');
    }

    const { token, tokenHash } = generateUploadToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + cfg.uploadTokenTtlMinutes * 60_000);

    const session = await this.sessionModel.create({
      shopId: cfg.shopId,
      adminId: new Types.ObjectId(adminId),
      status: ShopeeSyncSessionStatus.CREATED,
      syncMode: ShopeeSyncMode.FULL,
      forceFullSync: !!dto.forceFullSync,
      uploadTokenHash: tokenHash,
      uploadTokenExpiresAt: expiresAt,
      extensionVersion: dto.extensionVersion,
      adapterVersion: cfg.adapterVersion,
      startedAt: now,
    });

    return {
      id: session._id.toString(),
      uploadToken: token,
      expiresAt: expiresAt.toISOString(),
      shopId: cfg.shopId,
      config: {
        pageSize: cfg.pageSize,
        maxPages: cfg.maxPages,
        maxProducts: cfg.maxProducts,
        adapterVersion: cfg.adapterVersion,
        imageUrlTemplate: cfg.imageUrlTemplate,
      },
    };
  }

  /**
   * "Đồng bộ theo Product ID" — admin supplies exact Shopee product_id(s) directly,
   * bypassing the List phase entirely. The backend already knows exactly which ids
   * need a Detail fetch, so the session is created straight into
   * LIST_SNAPSHOT_UPLOADED (mirroring the point processListSnapshot() would normally
   * reach) and `pendingDetailProductIds`/ShopeeSyncItem rows are staged up front.
   */
  async createManualSession(dto: CreateManualSyncSessionDto, adminId: string): Promise<CreateManualSessionResult> {
    const cfg = this.assertSyncAllowed(dto.extensionVersion);

    const productIds = Array.from(new Set(dto.productIds));

    const existingProducts = await this.productModel
      .find({ channel: MarketplaceChannel.SHOPEE, shopId: cfg.shopId, externalProductId: { $in: productIds } })
      .select('externalProductId')
      .lean()
      .exec();
    const existingIds = new Set(existingProducts.map((p) => p.externalProductId));

    const { token, tokenHash } = generateUploadToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + cfg.uploadTokenTtlMinutes * 60_000);

    const session = await this.sessionModel.create({
      shopId: cfg.shopId,
      adminId: new Types.ObjectId(adminId),
      status: ShopeeSyncSessionStatus.LIST_SNAPSHOT_UPLOADED,
      syncMode: ShopeeSyncMode.MANUAL,
      forceFullSync: false,
      uploadTokenHash: tokenHash,
      uploadTokenExpiresAt: expiresAt,
      expectedTotal: productIds.length,
      collectedTotal: productIds.length,
      newCount: productIds.filter((id) => !existingIds.has(id)).length,
      changedCount: productIds.filter((id) => existingIds.has(id)).length,
      pendingDetailProductIds: productIds,
      extensionVersion: dto.extensionVersion,
      adapterVersion: cfg.adapterVersion,
      startedAt: now,
    });

    await this.itemModel.insertMany(
      productIds.map((externalProductId) => ({
        syncSessionId: session._id,
        externalProductId,
        status: decideManualSyncStatus(existingIds.has(externalProductId)),
        sourceModifiedAt: 0, // sentinel: manual sync never diffs on modifyTime, see decideManualSyncStatus()
        detailUploaded: false,
      })),
    );

    return {
      id: session._id.toString(),
      uploadToken: token,
      expiresAt: expiresAt.toISOString(),
      shopId: cfg.shopId,
      config: {
        pageSize: cfg.pageSize,
        maxPages: cfg.maxPages,
        maxProducts: cfg.maxProducts,
        adapterVersion: cfg.adapterVersion,
        imageUrlTemplate: cfg.imageUrlTemplate,
      },
      detailProductIds: productIds,
    };
  }


  async getLatestSession(shopId?: string) {
    const filter = shopId ? { shopId } : {};
    return this.sessionModel.findOne(filter).sort({ createdAt: -1 }).lean().exec();
  }

  async getSessionById(id: string) {
    return this.findSessionOrThrow(id);
  }

  private async findSessionOrThrow(id: string): Promise<ShopeeSyncSessionDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Không tìm thấy phiên đồng bộ');
    }
    const session = await this.sessionModel.findById(id).exec();
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên đồng bộ');
    }
    return session;
  }

  // ── Step 1: List snapshot ───────────────────────────────────────────────────

  async processListSnapshot(session: ShopeeSyncSessionDocument, dto: ListSnapshotDto) {
    const cfg = this.configService.get();
    if (dto.total > cfg.maxProducts) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_SNAPSHOT_INCOMPLETE,
        `Tổng số product (${dto.total}) vượt giới hạn cho phép (${cfg.maxProducts})`,
        HttpStatus.BAD_REQUEST,
      );
    }
    assertSnapshotIntegrity(dto.items, dto.total);

    const externalIds = dto.items.map((i) => i.externalProductId);
    const existingProducts = await this.productModel
      .find({ channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: { $in: externalIds } })
      .select('externalProductId sourceModifiedAt lastDetailSyncFailed syncStatus')
      .lean()
      .exec();
    const existingByExternalId = new Map(existingProducts.map((p) => [p.externalProductId, p]));

    const newIds: string[] = [];
    const changedIds: string[] = [];
    const unchangedIds: string[] = [];

    const bulkOps = dto.items.map((item) => {
      const existing = existingByExternalId.get(item.externalProductId) ?? null;
      const status = decideProductIndexStatus(existing, item.modifyTime, session.forceFullSync);
      if (status === ShopeeSyncItemStatus.NEW) newIds.push(item.externalProductId);
      else if (status === ShopeeSyncItemStatus.CHANGED) changedIds.push(item.externalProductId);
      else unchangedIds.push(item.externalProductId);

      return {
        updateOne: {
          filter: { syncSessionId: session._id, externalProductId: item.externalProductId },
          update: {
            $set: {
              status,
              sourceModifiedAt: item.modifyTime,
              detailUploaded: false,
              productPayload: null,
              errorCode: null,
              errorMessage: null,
            },
          },
          upsert: true,
        },
      };
    });

    if (bulkOps.length > 0) {
      await this.itemModel.bulkWrite(bulkOps);
    }

    const detailProductIds = [...newIds, ...changedIds];

    session.expectedTotal = dto.total;
    session.collectedTotal = dto.items.length;
    session.newCount = newIds.length;
    session.changedCount = changedIds.length;
    session.unchangedCount = unchangedIds.length;
    session.pendingDetailProductIds = detailProductIds;
    session.status =
      detailProductIds.length > 0 ? ShopeeSyncSessionStatus.LIST_SNAPSHOT_UPLOADED : ShopeeSyncSessionStatus.READY_FOR_PREVIEW;
    if (detailProductIds.length === 0) session.completedAt = new Date();
    await session.save();

    return {
      total: dto.total,
      newProductIds: newIds,
      changedProductIds: changedIds,
      unchangedProductIds: unchangedIds,
      detailProductIds,
    };
  }

  // ── Step 2: Per-product Detail upload ───────────────────────────────────────

  async uploadProductDetail(session: ShopeeSyncSessionDocument, productId: string, dto: UploadProductDetailDto) {
    const item = await this.itemModel.findOne({ syncSessionId: session._id, externalProductId: productId }).exec();
    if (!item) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        `Product ${productId} không có trong snapshot của phiên này`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (item.status === ShopeeSyncItemStatus.UNCHANGED || item.status === ShopeeSyncItemStatus.MISSING) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        `Product ${productId} không cần Detail (trạng thái: ${item.status})`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (dto.failed) {
      item.status = ShopeeSyncItemStatus.FAILED;
      item.detailUploaded = false;
      item.productPayload = null;
      item.errorCode = dto.errorCode ?? null;
      item.errorMessage = dto.errorMessage ?? null;
      await item.save();
    } else {
      if (!dto.product) {
        throw new ShopeeSyncException(
          ShopeeSyncErrorCode.LUXE_GLOW_UPLOAD_FAILED,
          'Thiếu dữ liệu product khi upload Detail',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (dto.product.externalProductId !== productId) {
        throw new ShopeeSyncException(
          ShopeeSyncErrorCode.SHOPEE_PRODUCT_ID_MISMATCH,
          `Payload externalProductId (${dto.product.externalProductId}) khác với productId trên URL (${productId})`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const normalizedPayload = this.hardenProductPayload(dto.product);
      // item.status (NEW/CHANGED) is intentionally left untouched — that decision was
      // already made in processListSnapshot(); this call only attaches the payload.
      item.detailUploaded = true;
      item.productPayload = normalizedPayload as unknown as Record<string, unknown>;
      item.sourceModifiedAt = dto.product.sourceModifiedAt;
      item.errorCode = null;
      item.errorMessage = null;
      await item.save();
    }

    session.pendingDetailProductIds = session.pendingDetailProductIds.filter((id) => id !== productId);
    if (dto.failed) session.failedCount += 1;
    if (session.pendingDetailProductIds.length === 0) {
      session.status = ShopeeSyncSessionStatus.READY_FOR_PREVIEW;
      session.completedAt = new Date();
    }
    await session.save();

    return {
      externalProductId: productId,
      status: item.status,
      remaining: session.pendingDetailProductIds.length,
    };
  }

  /** Server-side hardening: never trust the extension's own effectivePrice/image URLs. */
  private hardenProductPayload(product: MarketplaceProductUploadDto): MarketplaceProductUploadDto {
    const cfg = this.configService.get();
    return {
      ...product,
      images: product.images.map((img) => ({
        ...img,
        sourceUrl: resolveShopeeImageUrl(img.sourceImageId, img.sourceUrl, cfg.imageUrlTemplate),
      })),
      videoUrl: resolveShopeeVideoUrl(product.videoId, cfg.videoUrlTemplate),
      variants: product.variants.map((v) => ({
        ...v,
        imageUrl: v.imageId ? resolveShopeeImageUrl(v.imageId, v.imageUrl ?? '', cfg.imageUrlTemplate) : null,
        effectivePrice: computeEffectivePrice(v.normalPrice, v.promotionPrice),
      })),
    };
  }

  // ── Step 3: Preview ─────────────────────────────────────────────────────────

  async preview(id: string) {
    const session = await this.findSessionOrThrow(id);
    if (session.status !== ShopeeSyncSessionStatus.READY_FOR_PREVIEW) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        `Phiên đồng bộ chưa sẵn sàng để preview (trạng thái hiện tại: ${session.status})`,
        HttpStatus.CONFLICT,
      );
    }

    const items = await this.itemModel.find({ syncSessionId: session._id }).lean().exec();
    const seenExternalIds = items.map((i) => i.externalProductId);

    const existingProducts = await this.productModel
      .find({ channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: { $in: seenExternalIds } })
      .lean()
      .exec();
    const existingByExternalId = new Map(existingProducts.map((p) => [p.externalProductId, p]));

    const changedExternalIds = items.filter((i) => i.status === ShopeeSyncItemStatus.CHANGED).map((i) => i.externalProductId);
    const changedProductIds = existingProducts.filter((p) => changedExternalIds.includes(p.externalProductId)).map((p) => p._id);
    const [existingVariantsAll, existingImagesAll] = await Promise.all([
      this.variantModel.find({ marketplaceProductId: { $in: changedProductIds } }).lean().exec(),
      this.imageModel.find({ marketplaceProductId: { $in: changedProductIds }, isActive: true }).lean().exec(),
    ]);

    const productEntries = items.map((item) => {
      const base = { externalProductId: item.externalProductId, changeType: item.status as string };
      if (item.status === ShopeeSyncItemStatus.FAILED) {
        return { ...base, errorCode: item.errorCode, errorMessage: item.errorMessage };
      }
      if (item.status === ShopeeSyncItemStatus.UNCHANGED) {
        const existing = existingByExternalId.get(item.externalProductId);
        return { ...base, name: existing?.name ?? item.externalProductId };
      }
      if (item.status === ShopeeSyncItemStatus.NEW) {
        const payload = item.productPayload as unknown as MarketplaceProductUploadDto | null;
        return { ...base, name: payload?.name ?? item.externalProductId };
      }
      // CHANGED
      const existing = existingByExternalId.get(item.externalProductId);
      const payload = item.productPayload as unknown as MarketplaceProductUploadDto | null;
      if (!existing || !payload) return { ...base, name: payload?.name ?? item.externalProductId, fieldChanges: [], variantChanges: [] };

      const productIdStr = existing._id.toString();
      const existingVariants = existingVariantsAll
        .filter((v) => v.marketplaceProductId.toString() === productIdStr)
        .map((v) => ({
          externalVariantId: v.externalVariantId,
          sku: v.sku,
          normalPrice: v.normalPrice,
          promotionPrice: v.promotionPrice,
          effectivePrice: v.effectivePrice,
          availableStock: v.availableStock,
          imageId: v.imageId,
          isActive: v.isActive,
        }));
      const existingImageIds = existingImagesAll
        .filter((img) => img.marketplaceProductId.toString() === productIdStr && img.imageType !== MarketplaceImageType.VARIANT)
        .map((img) => img.sourceImageId);

      return {
        ...base,
        name: payload.name,
        fieldChanges: diffProductFields(existing, payload),
        variantChanges: diffVariants(
          existingVariants,
          payload.variants.map((v) => ({
            externalVariantId: v.externalVariantId,
            sku: v.sku ?? null,
            normalPrice: v.normalPrice,
            promotionPrice: v.promotionPrice,
            effectivePrice: v.effectivePrice,
            availableStock: v.availableStock,
            imageId: v.imageId ?? null,
          })),
        ),
        imageChanges: diffImageIds(existingImageIds, payload.images.map((i) => i.sourceImageId)),
      };
    });

    // Products previously known for this shop but absent from the current full snapshot.
    // MANUAL sessions only ever cover a handful of admin-picked ids — never the whole
    // catalog — so missing-product detection MUST be skipped entirely for them, or every
    // other already-synced product would be false-positively flagged as no-longer-on-Shopee.
    const missingProducts =
      session.syncMode === ShopeeSyncMode.MANUAL
        ? []
        : await this.productModel
            .find({
              channel: MarketplaceChannel.SHOPEE,
              shopId: session.shopId,
              externalProductId: { $nin: seenExternalIds },
              syncStatus: { $ne: MarketplaceProductSyncStatus.ARCHIVED },
            })
            .select('externalProductId name syncStatus')
            .lean()
            .exec();

    const missingEntries = missingProducts.map((p) => ({
      externalProductId: p.externalProductId,
      name: p.name,
      changeType: 'MISSING' as const,
      nextSyncStatus: nextSyncStatusWhenMissing(p.syncStatus),
    }));

    const summary = {
      total: session.expectedTotal ?? items.length,
      newProducts: productEntries.filter((e) => e.changeType === 'NEW'),
      changedProducts: productEntries.filter((e) => e.changeType === 'CHANGED'),
      unchangedProducts: productEntries.filter((e) => e.changeType === 'UNCHANGED'),
      failedProducts: productEntries.filter((e) => e.changeType === 'FAILED'),
      missingProducts: missingEntries,
    };

    session.previewSummary = summary;
    session.missingCount = missingEntries.length;
    session.status = ShopeeSyncSessionStatus.PREVIEWED;
    await session.save();

    return summary;
  }

  // ── Step 4: Commit ──────────────────────────────────────────────────────────

  async commit(id: string, adminId: string) {
    const session = await this.findSessionOrThrow(id);
    if (session.status !== ShopeeSyncSessionStatus.PREVIEWED) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        `Phiên đồng bộ phải ở trạng thái PREVIEWED mới được commit (hiện tại: ${session.status})`,
        HttpStatus.CONFLICT,
      );
    }

    const mongoSession = await this.connection.startSession();
    const publishableExternalIds: string[] = [];
    // Detail-fetch failures (Shopee call itself failed/schema mismatch) — distinct from
    // catalog-publish failures below. Previously only counted (`session.failedCount`),
    // never surfaced anywhere the admin could actually read the reason.
    const detailFailures: { externalProductId: string; errorCode: string | null; errorMessage: string | null }[] = [];
    try {
      await mongoSession.withTransaction(async () => {
        const items = await this.itemModel.find({ syncSessionId: session._id }).session(mongoSession).exec();
        const seenExternalIds = items.map((i) => i.externalProductId);

        for (const item of items) {
          if (item.status === ShopeeSyncItemStatus.NEW || item.status === ShopeeSyncItemStatus.CHANGED) {
            if (!item.productPayload) continue; // detail never actually arrived — leave as failed-equivalent, retried next sync
            await this.commitOneProduct(item.productPayload as unknown as MarketplaceProductUploadDto, session, mongoSession);
            publishableExternalIds.push(item.externalProductId);
          } else if (item.status === ShopeeSyncItemStatus.FAILED) {
            detailFailures.push({ externalProductId: item.externalProductId, errorCode: item.errorCode, errorMessage: item.errorMessage });
            await this.productModel
              .updateOne(
                { channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: item.externalProductId },
                { $set: { lastDetailSyncFailed: true } },
              )
              .session(mongoSession)
              .exec();
          } else if (item.status === ShopeeSyncItemStatus.UNCHANGED) {
            await this.productModel
              .updateOne(
                { channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: item.externalProductId },
                { $set: { lastSyncedAt: new Date(), syncStatus: MarketplaceProductSyncStatus.ACTIVE, missingSinceSyncSessionId: null } },
              )
              .session(mongoSession)
              .exec();
          }
        }

        // Same MANUAL guard as preview() — a targeted product_id sync must never mark
        // every other existing product as missing just because it's absent from this
        // tiny, deliberately-partial snapshot.
        const missingProducts =
          session.syncMode === ShopeeSyncMode.MANUAL
            ? []
            : await this.productModel
                .find({
                  channel: MarketplaceChannel.SHOPEE,
                  shopId: session.shopId,
                  externalProductId: { $nin: seenExternalIds },
                  syncStatus: { $ne: MarketplaceProductSyncStatus.ARCHIVED },
                })
                .session(mongoSession)
                .exec();

        for (const product of missingProducts) {
          const nextStatus = nextSyncStatusWhenMissing(product.syncStatus);
          product.syncStatus = nextStatus;
          if (!product.missingSinceSyncSessionId) product.missingSinceSyncSessionId = session._id.toString();
          await product.save({ session: mongoSession });
        }

        session.status = ShopeeSyncSessionStatus.COMMITTED;
        session.committedAt = new Date();
        session.missingCount = missingProducts.length;
        await session.save({ session: mongoSession });
      });
    } catch (err) {
      session.status = ShopeeSyncSessionStatus.FAILED;
      session.errorMessage = err instanceof Error ? err.message : 'Commit thất bại';
      await session.save();
      throw err;
    } finally {
      await mongoSession.endSession();
    }

    // Publish to the real catalog AFTER the mirror transaction has committed —
    // ProductsService calls don't participate in `mongoSession`, so this stays a
    // separate, best-effort phase: one product failing to publish must never roll
    // back the (already-committed) marketplace mirror data or block the others.
    let publishedCount = 0;
    let publishFailedCount = 0;
    const publishErrors: { externalProductId: string; error: string }[] = [];
    if (publishableExternalIds.length > 0) {
      const products = await this.productModel
        .find({ channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: { $in: publishableExternalIds } })
        .exec();
      const productIds = products.map((p) => p._id);
      const [variants, images] = await Promise.all([
        this.variantModel.find({ marketplaceProductId: { $in: productIds } }).exec(),
        this.imageModel.find({ marketplaceProductId: { $in: productIds } }).exec(),
      ]);
      for (const product of products) {
        const productVariants = variants.filter((v) => v.marketplaceProductId.equals(product._id));
        const productImages = images.filter((img) => img.marketplaceProductId.equals(product._id));
        const result = await this.catalogPublishService.publishProduct(product, productVariants, productImages, adminId);
        if (result.action === 'skipped') {
          publishFailedCount += 1;
          publishErrors.push({ externalProductId: result.externalProductId, error: result.error ?? 'Lỗi không xác định' });
        } else publishedCount += 1;
      }
    }

    await this.auditService.log({
      actorId: adminId,
      actorType: 'staff',
      action: 'shopee_sync.commit',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: session._id.toString(),
      afterData: {
        newCount: session.newCount,
        changedCount: session.changedCount,
        unchangedCount: session.unchangedCount,
        missingCount: session.missingCount,
        failedCount: session.failedCount,
        publishedCount,
        publishFailedCount,
        // Previously only counts were logged — the actual reason was discarded, leaving
        // admins with no way to see WHY something failed from the Audit Logs page.
        detailFailures: detailFailures.length > 0 ? detailFailures : undefined,
        publishErrors: publishErrors.length > 0 ? publishErrors : undefined,
      },
    });

    return {
      id: session._id.toString(),
      status: session.status,
      committedAt: session.committedAt,
      publishedCount,
      publishFailedCount,
      publishErrors,
      newCount: session.newCount,
      changedCount: session.changedCount,
      unchangedCount: session.unchangedCount,
      missingCount: session.missingCount,
      failedCount: session.failedCount,
      detailFailures,
    };
  }

  private async commitOneProduct(
    payload: MarketplaceProductUploadDto,
    session: ShopeeSyncSessionDocument,
    mongoSession: import('mongoose').ClientSession,
  ): Promise<void> {
    const now = new Date();
    const sourceHash = computeSourceHash(payload);
    const cover = payload.images.find((img) => img.sourceImageId === payload.coverImageId) ?? payload.images[0] ?? null;

    const product = await this.productModel
      .findOneAndUpdate(
        { channel: MarketplaceChannel.SHOPEE, shopId: session.shopId, externalProductId: payload.externalProductId },
        {
          $set: {
            name: payload.name,
            rawStatus: payload.rawStatus,
            parentSku: payload.parentSku ?? null,
            coverImageId: payload.coverImageId ?? null,
            coverImageUrl: cover?.sourceUrl ?? null,
            videoId: payload.videoId ?? null,
            videoUrl: payload.videoUrl ?? null,
            description: payload.description ?? null,
            descriptionType: payload.descriptionType ?? null,
            categoryIds: payload.categoryIds,
            categoryNames: payload.categoryNames,
            condition: payload.condition ?? null,
            brandId: payload.brandId ?? null,
            brandName: payload.brandName ?? null,
            priceMin: payload.priceMin,
            priceMax: payload.priceMax,
            sellingPriceMin: payload.sellingPriceMin,
            sellingPriceMax: payload.sellingPriceMax,
            availableStock: payload.availableStock,
            sellerStock: payload.sellerStock,
            shopeeStock: payload.shopeeStock,
            soldCount: payload.soldCount,
            viewCount: payload.viewCount,
            likedCount: payload.likedCount,
            weightValue: payload.weightValue ?? null,
            weightUnit: payload.weightUnit ?? null,
            dimension: payload.dimension,
            tierVariations: payload.tierVariations ?? [],
            preOrder: payload.preOrder,
            daysToShip: payload.daysToShip ?? null,
            sourceCreatedAt: payload.sourceCreatedAt,
            sourceModifiedAt: payload.sourceModifiedAt,
            sourceHash,
            syncStatus: MarketplaceProductSyncStatus.ACTIVE,
            lastSyncedAt: now,
            lastDetailSyncedAt: now,
            lastDetailSyncFailed: false,
            missingSinceSyncSessionId: null,
          },
        },
        { upsert: true, new: true, session: mongoSession },
      )
      .exec();

    const currentVariantIds = payload.variants.map((v) => v.externalVariantId);
    for (const v of payload.variants) {
      await this.variantModel
        .findOneAndUpdate(
          { marketplaceProductId: product._id, externalVariantId: v.externalVariantId },
          {
            $set: {
              variantName: v.name ?? null,
              sku: v.sku ?? null,
              tierIndexes: v.tierIndexes,
              imageId: v.imageId ?? null,
              imageUrl: v.imageUrl ?? null,
              normalPrice: v.normalPrice,
              promotionPrice: v.promotionPrice,
              effectivePrice: v.effectivePrice,
              availableStock: v.availableStock,
              sellerStock: v.sellerStock,
              shopeeStock: v.shopeeStock,
              reservedStock: v.reservedStock,
              soldCount: v.soldCount ?? null,
              availableStatus: v.availableStatus ?? null,
              preOrder: v.preOrder,
              daysToShip: v.daysToShip ?? null,
              isDefault: v.isDefault,
              isActive: true,
              sourceHash: computeSourceHash(v),
            },
          },
          { upsert: true, new: true, session: mongoSession },
        )
        .exec();
    }
    await this.variantModel
      .updateMany(
        { marketplaceProductId: product._id, externalVariantId: { $nin: currentVariantIds }, isActive: true },
        { $set: { isActive: false } },
        { session: mongoSession },
      )
      .exec();

    const currentImageKeys = payload.images.map((i) => `${i.sourceImageId}::${i.imageType}`);
    for (const img of payload.images) {
      await this.imageModel
        .findOneAndUpdate(
          { marketplaceProductId: product._id, sourceImageId: img.sourceImageId, imageType: img.imageType },
          { $set: { position: img.position, sourceUrl: img.sourceUrl, isActive: true, marketplaceVariantId: null } },
          { upsert: true, session: mongoSession },
        )
        .exec();
    }
    await this.imageModel
      .updateMany(
        {
          marketplaceProductId: product._id,
          imageType: { $ne: MarketplaceImageType.VARIANT },
          isActive: true,
          $expr: { $not: { $in: [{ $concat: ['$sourceImageId', '::', '$imageType'] }, currentImageKeys] } },
        },
        { $set: { isActive: false } },
        { session: mongoSession },
      )
      .exec();

    // Variant thumbnails also get their own row in marketplace_product_images (imageType VARIANT),
    // linked via marketplaceVariantId — this is what makes "all images of a product" a single query.
    const variantDocs = await this.variantModel.find({ marketplaceProductId: product._id }).session(mongoSession).exec();
    const variantByExternalId = new Map(variantDocs.map((v) => [v.externalVariantId, v]));
    const currentVariantImageIds: string[] = [];
    for (const v of payload.variants) {
      if (!v.imageId) continue;
      const variantDoc = variantByExternalId.get(v.externalVariantId);
      if (!variantDoc) continue;
      currentVariantImageIds.push(v.imageId);
      await this.imageModel
        .findOneAndUpdate(
          { marketplaceProductId: product._id, sourceImageId: v.imageId, imageType: MarketplaceImageType.VARIANT },
          {
            $set: {
              position: 0,
              sourceUrl: v.imageUrl ?? '',
              isActive: true,
              marketplaceVariantId: variantDoc._id,
            },
          },
          { upsert: true, session: mongoSession },
        )
        .exec();
    }
    await this.imageModel
      .updateMany(
        {
          marketplaceProductId: product._id,
          imageType: MarketplaceImageType.VARIANT,
          isActive: true,
          sourceImageId: { $nin: currentVariantImageIds },
        },
        { $set: { isActive: false } },
        { session: mongoSession },
      )
      .exec();
  }

  // ── Cancel ──────────────────────────────────────────────────────────────────

  async cancel(id: string, adminId: string) {
    const session = await this.findSessionOrThrow(id);
    if (session.status === ShopeeSyncSessionStatus.COMMITTED) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        'Phiên đồng bộ đã commit, không thể hủy',
        HttpStatus.CONFLICT,
      );
    }

    session.status = ShopeeSyncSessionStatus.CANCELLED;
    session.completedAt = new Date();
    session.errorCode = ShopeeSyncErrorCode.SYNC_CANCELLED;
    await session.save();

    await this.itemModel.updateMany({ syncSessionId: session._id }, { $set: { productPayload: null } }).exec();

    await this.auditService.log({
      actorId: adminId,
      actorType: 'staff',
      action: 'shopee_sync.cancel',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: session._id.toString(),
    });

    return { id: session._id.toString(), status: session.status };
  }
}
