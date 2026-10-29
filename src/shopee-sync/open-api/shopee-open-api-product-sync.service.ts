import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { MarketplaceChannel, MarketplaceProduct, MarketplaceProductDocument } from '../schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantDocument } from '../schemas/marketplace-variant.schema';
import {
  ShopeeSyncMode,
  ShopeeSyncSession,
  ShopeeSyncSessionDocument,
  ShopeeSyncSessionStatus,
  ShopeeSyncSource,
} from '../schemas/shopee-sync-session.schema';
import { MarketplaceProductUploadDto } from '../dto/marketplace-product-upload.dto';
import { ShopeeSyncService } from '../shopee-sync.service';
import { ShopeeSyncConfigService } from '../shopee-sync.config';
import { ShopeeSyncErrorCode, SHOPEE_SYNC_AUDIT_MODULE } from '../shopee-sync.constants';
import { ShopeeSyncException } from '../shopee-sync.exceptions';
import { ShopeeOpenApiAuthService } from './shopee-open-api-auth.service';
import { ITEM_ID_BATCH_SIZE, ITEM_LIST_PAGE_SIZE, ShopeeOpenApiCallError, ShopeeOpenApiService } from './shopee-open-api.service';
import { mapShopeeItemToUpload, ShopeeProductMappingError, SYNCABLE_ITEM_STATUSES, ITEM_STATUS_TO_RAW } from './shopee-open-api-product.mapper';
import type { ShopeeItemExtraInfo } from './shopee-open-api.types';

/** A running OPEN_API session untouched this long is assumed dead (backend restarted mid-job). */
const STALE_RUNNING_SESSION_MS = 10 * 60 * 1000;
/** Only bookkeeping for the shared schema — backend-run sessions never hand out the token. */
const OPEN_API_SESSION_TTL_MINUTES = 180;
const RUNNING_STATUSES = [ShopeeSyncSessionStatus.CREATED, ShopeeSyncSessionStatus.LIST_SNAPSHOT_UPLOADED];

/**
 * Product sync via Shopee Open Platform v2 — the server-side replacement for the Chrome
 * Extension's collection phase. It produces exactly what the extension used to upload
 * (ListSnapshotDto, then one MarketplaceProductUploadDto per product) and hands it to the
 * SAME ShopeeSyncService methods, so staging → Preview → admin "Xác nhận" → Commit →
 * catalog publish are untouched and still require an explicit admin confirmation.
 *
 * The job runs in the background of the request that started it; the Admin page follows
 * it through the existing `GET sync-sessions/:id` polling.
 */
@Injectable()
export class ShopeeOpenApiProductSyncService {
  private readonly logger = new Logger(ShopeeOpenApiProductSyncService.name);

  constructor(
    @InjectModel(ShopeeSyncSession.name) private readonly sessionModel: Model<ShopeeSyncSessionDocument>,
    @InjectModel(MarketplaceProduct.name) private readonly productModel: Model<MarketplaceProductDocument>,
    @InjectModel(MarketplaceVariant.name) private readonly variantModel: Model<MarketplaceVariantDocument>,
    private readonly syncService: ShopeeSyncService,
    private readonly syncConfig: ShopeeSyncConfigService,
    private readonly auth: ShopeeOpenApiAuthService,
    private readonly api: ShopeeOpenApiService,
    private readonly auditService: AuditService,
  ) {}

  async startFullSync(adminId: string, isSuperAdmin: boolean, forceFullSync: boolean) {
    if (forceFullSync && !isSuperAdmin) throw new ForbiddenException('Chỉ Super Admin được chọn Force Full Sync');
    await this.auth.requireConnected();
    await this.assertNoRunningSession();
    const session = await this.syncService.createOpenApiSession(
      { mode: ShopeeSyncMode.FULL, forceFullSync, ttlMinutes: OPEN_API_SESSION_TTL_MINUTES },
      adminId,
    );
    await this.audit(adminId, session, { forceFullSync });
    void this.runJob(session._id, () => this.runFull(session._id));
    return this.summary(session);
  }

  async startManualSync(adminId: string, productIds: string[]) {
    await this.auth.requireConnected();
    await this.assertNoRunningSession();
    const session = await this.syncService.createOpenApiSession(
      { mode: ShopeeSyncMode.MANUAL, forceFullSync: false, productIds, ttlMinutes: OPEN_API_SESSION_TTL_MINUTES },
      adminId,
    );
    await this.audit(adminId, session, { productIds: session.pendingDetailProductIds });
    void this.runJob(session._id, () => this.fetchDetails(session._id, session.pendingDetailProductIds, new Map()));
    return this.summary(session);
  }

  // ─── Job ───────────────────────────────────────────────────────────────────

  private async runJob(sessionId: Types.ObjectId, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch (err) {
      const code = err instanceof ShopeeOpenApiCallError ? err.errorCode : ShopeeSyncErrorCode.SHOPEE_OPEN_API_ERROR;
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      this.logger.error(`Shopee Open API product sync ${sessionId} thất bại: ${code} — ${message}`);
      await this.syncService.failSession(sessionId, code, message).catch(() => undefined);
    }
  }

  private async runFull(sessionId: Types.ObjectId): Promise<void> {
    const { maxProducts } = this.syncConfig.get();
    const updateTimes = new Map<string, number>();
    const items: { externalProductId: string; modifyTime: number; createTime: number; status: number }[] = [];

    let offset = 0;
    for (;;) {
      const page = await this.api.getItemList({ offset, pageSize: ITEM_LIST_PAGE_SIZE, itemStatus: SYNCABLE_ITEM_STATUSES });
      for (const it of page.item ?? []) {
        if (!it.item_id) continue;
        const id = String(it.item_id);
        if (updateTimes.has(id)) continue; // defensive: offset paging can repeat an item updated mid-scan
        const modifyTime = Math.max(0, Math.floor(Number(it.update_time) || 0));
        updateTimes.set(id, modifyTime);
        items.push({ externalProductId: id, modifyTime, createTime: 0, status: it.item_status ? ITEM_STATUS_TO_RAW[it.item_status] ?? 0 : 0 });
      }
      if (items.length > maxProducts) {
        throw new ShopeeOpenApiCallError('PERMANENT', ShopeeSyncErrorCode.SHOPEE_SNAPSHOT_INCOMPLETE, `Shop có hơn ${maxProducts} sản phẩm (SHOPEE_SYNC_MAX_PRODUCTS)`);
      }
      if (!(await this.stillRunning(sessionId, { collectedTotal: items.length }))) return;
      if (!page.has_next_page) break;
      const next = Number(page.next_offset);
      if (!Number.isFinite(next) || next <= offset) {
        throw new ShopeeOpenApiCallError('PERMANENT', ShopeeSyncErrorCode.SHOPEE_CURSOR_LOOP, 'get_item_list trả next_offset không tăng');
      }
      offset = next;
    }

    const session = await this.sessionModel.findById(sessionId).exec();
    if (!session || session.status !== ShopeeSyncSessionStatus.CREATED) return; // cancelled meanwhile
    const result = await this.syncService.processListSnapshot(session, { total: items.length, items });
    await this.fetchDetails(sessionId, result.detailProductIds, updateTimes);
  }

  /** Detail phase: base info + extra info per 50 ids, model list per item with variations. */
  private async fetchDetails(sessionId: Types.ObjectId, productIds: string[], updateTimes: Map<string, number>): Promise<void> {
    const cfg = this.syncConfig.get();
    for (let i = 0; i < productIds.length; i += ITEM_ID_BATCH_SIZE) {
      const chunk = productIds.slice(i, i + ITEM_ID_BATCH_SIZE);
      if (!(await this.stillRunning(sessionId))) return;

      const [baseRes, extraById, hints] = await Promise.all([
        this.api.getItemBaseInfo(chunk),
        this.api
          .getItemExtraInfo(chunk)
          .then((r) => new Map((r.item_list ?? []).map((x): [string, ShopeeItemExtraInfo] => [String(x.item_id), x])))
          .catch((err) => {
            if (err instanceof ShopeeOpenApiCallError && err.isFatal) throw err;
            return new Map<string, ShopeeItemExtraInfo>(); // sold/views/likes are cosmetic
          }),
        this.loadHints(chunk),
      ]);
      const baseById = new Map((baseRes.item_list ?? []).map((b) => [String(b.item_id), b]));

      for (const productId of chunk) {
        const session = await this.sessionModel.findById(sessionId).exec();
        if (!session || session.status !== ShopeeSyncSessionStatus.LIST_SNAPSHOT_UPLOADED) return;

        const base = baseById.get(productId);
        if (!base) {
          await this.syncService.uploadProductDetail(session, productId, {
            failed: true,
            errorCode: ShopeeSyncErrorCode.SHOPEE_DETAIL_API_ERROR,
            errorMessage: 'Shopee không trả về sản phẩm này (đã xoá hoặc không thuộc shop?)',
          });
          continue;
        }

        try {
          const models = base.has_model ? await this.api.getModelList(productId) : null;
          const hint = hints.get(productId);
          const product = mapShopeeItemToUpload(base, models, extraById.get(productId) ?? null, {
            imageUrlTemplate: cfg.imageUrlTemplate,
            videoUrlTemplate: cfg.videoUrlTemplate,
            listUpdateTime: updateTimes.get(productId),
            existingDefaultVariantId: hint?.defaultVariantId ?? null,
          });
          // Open API only gives the leaf category id — keep the full path/names the mirror
          // already has (from the extension) when it ends in the same leaf.
          if (hint && product.categoryIds.length === 1 && hint.categoryIds[hint.categoryIds.length - 1] === product.categoryIds[0]) {
            product.categoryIds = hint.categoryIds;
            product.categoryNames = hint.categoryNames;
          }
          assertValidUpload(product);
          await this.syncService.uploadProductDetail(session, productId, { product });
        } catch (err) {
          if (err instanceof ShopeeOpenApiCallError && err.isFatal) throw err;
          const errorCode =
            err instanceof ShopeeOpenApiCallError
              ? ShopeeSyncErrorCode.SHOPEE_DETAIL_API_ERROR
              : err instanceof ShopeeProductMappingError
                ? ShopeeSyncErrorCode.SHOPEE_OPEN_API_MAPPING_FAILED
                : ShopeeSyncErrorCode.SHOPEE_DETAIL_SCHEMA_CHANGED;
          await this.syncService.uploadProductDetail(session, productId, {
            failed: true,
            errorCode,
            errorMessage: ((err as Error)?.message ?? 'Lỗi không xác định').slice(0, 500),
          });
        }
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** One running backend sync per shop. A session idle > 10 min is a leftover of a restart. */
  private async assertNoRunningSession(): Promise<void> {
    const { shopId } = this.syncConfig.get();
    const running = await this.sessionModel
      .findOne({ shopId, source: ShopeeSyncSource.OPEN_API, status: { $in: RUNNING_STATUSES } })
      .sort({ createdAt: -1 })
      .exec();
    if (!running) return;
    if (Date.now() - new Date(running.updatedAt).getTime() > STALE_RUNNING_SESSION_MS) {
      await this.syncService.failSession(
        running._id,
        ShopeeSyncErrorCode.SHOPEE_OPEN_API_JOB_INTERRUPTED,
        'Phiên bị gián đoạn (backend khởi động lại giữa chừng)',
      );
      return;
    }
    throw new ShopeeSyncException(
      ShopeeSyncErrorCode.SHOPEE_OPEN_API_SYNC_IN_PROGRESS,
      'Đang có một phiên đồng bộ Shopee qua API chạy — vui lòng chờ hoặc huỷ phiên đó',
      HttpStatus.CONFLICT,
    );
  }

  /** Heartbeat (keeps updatedAt fresh for stale detection) + cancellation check. */
  private async stillRunning(sessionId: Types.ObjectId, set: Record<string, unknown> = {}): Promise<boolean> {
    const res = await this.sessionModel
      // Mongoose `timestamps` bumps updatedAt on every updateOne, even with an empty $set.
      .updateOne({ _id: sessionId, status: { $in: RUNNING_STATUSES } }, { $set: set })
      .exec();
    return res.matchedCount > 0;
  }

  private async loadHints(productIds: string[]) {
    const { shopId } = this.syncConfig.get();
    const products = await this.productModel
      .find({ channel: MarketplaceChannel.SHOPEE, shopId, externalProductId: { $in: productIds } })
      .select('_id externalProductId categoryIds categoryNames')
      .lean()
      .exec();
    const defaults = await this.variantModel
      .find({ marketplaceProductId: { $in: products.map((p) => p._id) }, isDefault: true, isActive: true })
      .select('marketplaceProductId externalVariantId')
      .lean()
      .exec();
    const defaultByProduct = new Map(defaults.map((v) => [v.marketplaceProductId.toString(), v.externalVariantId]));
    return new Map(
      products.map((p) => [
        p.externalProductId,
        {
          categoryIds: p.categoryIds ?? [],
          categoryNames: p.categoryNames ?? [],
          defaultVariantId: defaultByProduct.get(p._id.toString()) ?? null,
        },
      ]),
    );
  }

  private async audit(adminId: string, session: ShopeeSyncSessionDocument, extra: Record<string, unknown>) {
    await this.auditService.log({
      actorId: adminId,
      actorType: 'staff',
      action: 'shopee_sync.open_api_start',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: session._id.toString(),
      afterData: { syncMode: session.syncMode, ...extra },
    });
  }

  private summary(session: ShopeeSyncSessionDocument) {
    return {
      id: session._id.toString(),
      status: session.status,
      syncMode: session.syncMode,
      source: session.source,
      detailProductIds: session.pendingDetailProductIds,
    };
  }
}

/** Same contract the extension's upload goes through (global ValidationPipe) — a payload
 * that would have been rejected over HTTP must not slip into staging via this path. */
function assertValidUpload(product: MarketplaceProductUploadDto): void {
  const errors = validateSync(plainToInstance(MarketplaceProductUploadDto, product));
  if (errors.length) {
    const detail = errors
      .flatMap((e) => flattenConstraints(e))
      .slice(0, 3)
      .join('; ');
    throw new ShopeeProductMappingError(`Dữ liệu sản phẩm không hợp lệ: ${detail}`);
  }
}

function flattenConstraints(e: { property: string; constraints?: Record<string, string>; children?: unknown[] }): string[] {
  const own = Object.values(e.constraints ?? {}).map((c) => `${e.property}: ${c}`);
  const nested = ((e.children ?? []) as (typeof e)[]).flatMap(flattenConstraints);
  return [...own, ...nested];
}
