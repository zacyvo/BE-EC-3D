import { BadRequestException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ShopeeOrderSyncBatch,
  ShopeeOrderSyncBatchDocument,
  ShopeeOrderSyncSource,
} from '../schemas/shopee-order-sync-batch.schema';
import {
  ShopeeOpenApiCredential,
  ShopeeOpenApiCredentialDocument,
  ShopeeOpenApiCredentialStatus,
} from '../schemas/shopee-open-api-credential.schema';
import { ShopeeOrderSyncService } from '../shopee-order-sync.service';
import { ShopeeSyncConfigService } from '../shopee-sync.config';
import { ShopeeSyncErrorCode } from '../shopee-sync.constants';
import { ShopeeSyncException } from '../shopee-sync.exceptions';
import type { ShopeeOrderRawRow } from '../shopee-order-mapping.util';
import { SHOPEE_CREDENTIAL_KEY, ShopeeOpenApiAuthService } from './shopee-open-api-auth.service';
import { ShopeeOpenApiConfigService } from './shopee-open-api.config';
import { ORDER_LIST_MAX_RANGE_S, ORDER_SN_BATCH_SIZE, ShopeeOpenApiCallError, ShopeeOpenApiService } from './shopee-open-api.service';
import { ESCROW_STATUSES, mapShopeeApiOrderToRows, SKIPPED_STATUSES, TRACKING_STATUSES } from './shopee-open-api-order.mapper';
import type { ShopeeApiOrderStatus, ShopeeEscrowDetailResponse } from './shopee-open-api.types';

const LOCK_LEASE_MS = 10 * 60 * 1000;
const MAX_MANUAL_RANGE_DAYS = 90;
const DEFAULT_MANUAL_RANGE_DAYS = 7;

/**
 * Order sync via Shopee Open Platform v2 — replaces the "Xuất file Excel → tải lên" routine:
 *   order/get_order_list (by update_time, 15-day windows) → order/get_order_detail (50/call)
 *   → logistics/get_tracking_number (shipped orders) → payment/get_escrow_detail (completed)
 * Each order is mapped to the Excel row shape and fed to ShopeeOrderSyncService.importOrderGroups,
 * so dedup by order code, update-only-when-better shipping info, the review queue and
 * resolve/dismiss all behave exactly as for Excel. Gains over Excel: exact seller payout
 * (escrow_amount), exact product link via Shopee item_id, no manual export step.
 */
@Injectable()
export class ShopeeOpenApiOrderSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopeeOpenApiOrderSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(ShopeeOrderSyncBatch.name) private readonly batchModel: Model<ShopeeOrderSyncBatchDocument>,
    @InjectModel(ShopeeOpenApiCredential.name) private readonly credentialModel: Model<ShopeeOpenApiCredentialDocument>,
    private readonly orderSync: ShopeeOrderSyncService,
    private readonly syncConfig: ShopeeSyncConfigService,
    private readonly configService: ShopeeOpenApiConfigService,
    private readonly auth: ShopeeOpenApiAuthService,
    private readonly api: ShopeeOpenApiService,
  ) {}

  onModuleInit(): void {
    const minutes = this.configService.get().orderAutoSyncMinutes;
    if (minutes > 0 && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.runScheduled(), Math.max(5, minutes) * 60_000);
      this.logger.log(`Shopee Open API: tự động đồng bộ đơn mỗi ${Math.max(5, minutes)} phút`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Admin "Đồng bộ đơn qua API" — runs in the background, returns the RUNNING batch. */
  async startManualSync(staffId: string, range: { from?: string; to?: string }): Promise<ShopeeOrderSyncBatchDocument> {
    this.assertEnabled();
    await this.auth.requireConnected();
    const { from, to } = resolveRange(range);

    if (!(await this.auth.acquireOrderSyncLock(LOCK_LEASE_MS))) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_OPEN_API_SYNC_IN_PROGRESS,
        'Đang có một lượt đồng bộ đơn Shopee chạy — vui lòng chờ ít phút',
        HttpStatus.CONFLICT,
      );
    }
    let batch: ShopeeOrderSyncBatchDocument;
    try {
      batch = await this.createBatch(staffId, from, to, false);
    } catch (err) {
      await this.auth.releaseOrderSyncLock(false);
      throw err;
    }
    void this.run(batch, from, to, staffId);
    return batch;
  }

  // ─── Scheduled ─────────────────────────────────────────────────────────────

  private async runScheduled(): Promise<void> {
    try {
      if (!this.syncConfig.get().enabled || this.configService.configErrors().length) return;
      const cred = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).lean().exec();
      if (!cred?.refreshTokenEnc || cred.status !== ShopeeOpenApiCredentialStatus.ACTIVE || !cred.authorizedBy) return;
      if (!(await this.auth.acquireOrderSyncLock(LOCK_LEASE_MS))) return; // another instance / a manual run

      const to = new Date();
      const from = new Date(to.getTime() - this.configService.get().orderAutoSyncLookbackHours * 3600_000);
      // Orders are attributed to the admin who connected the shop (Order import needs a staff actor).
      const staffId = cred.authorizedBy.toString();
      const batch = await this.createBatch(staffId, from, to, true);
      await this.run(batch, from, to, staffId);
      // Keep the batch history readable: a scheduled run that found nothing leaves no trace.
      const done = await this.batchModel.findById(batch._id).select('totalOrders status').lean().exec();
      if (done && done.totalOrders === 0 && done.status !== 'FAILED') await this.batchModel.deleteOne({ _id: batch._id }).exec();
    } catch (err) {
      this.logger.error(`Shopee Open API: tự động đồng bộ đơn lỗi: ${(err as Error)?.message}`);
      await this.auth.releaseOrderSyncLock(false);
    }
  }

  // ─── Job (lock already held) ───────────────────────────────────────────────

  private async run(batch: ShopeeOrderSyncBatchDocument, from: Date, to: Date, staffId: string): Promise<void> {
    let completed = false;
    try {
      const orderSns = await this.listOrderSns(batch, from, to);
      const groups = new Map<string, ShopeeOrderRawRow[]>();
      const preFailed: { orderCode: string; message: string }[] = [];

      for (let i = 0; i < orderSns.length; i += ORDER_SN_BATCH_SIZE) {
        await this.heartbeat(batch);
        const chunk = orderSns.slice(i, i + ORDER_SN_BATCH_SIZE);
        const detail = await this.api.getOrderDetail(chunk);
        const returned = new Set<string>();

        for (const order of detail.order_list ?? []) {
          const orderSn = order.order_sn ?? '';
          returned.add(orderSn);
          try {
            const status = order.order_status as ShopeeApiOrderStatus;
            const trackingNumber = TRACKING_STATUSES.includes(status) ? await this.tryTracking(orderSn, order.package_list?.[0]?.package_number) : null;
            let escrow: ShopeeEscrowDetailResponse | null = null;
            if (ESCROW_STATUSES.includes(status)) {
              // Required: without it a DELIVERED order's paidAmount would be guessed. Failing
              // the order (retried next run) beats storing a wrong payout.
              escrow = await this.api.getEscrowDetail(orderSn);
            }
            groups.set(orderSn, mapShopeeApiOrderToRows(order, { escrow, trackingNumber }));
          } catch (err) {
            if (err instanceof ShopeeOpenApiCallError && err.isFatal) throw err;
            preFailed.push({ orderCode: orderSn || '(không rõ mã)', message: (err as Error)?.message ?? 'Lỗi không xác định' });
          }
        }
        for (const sn of chunk) {
          if (!returned.has(sn)) preFailed.push({ orderCode: sn, message: 'get_order_detail không trả về đơn này' });
        }
      }

      await this.orderSync.importOrderGroups(batch, groups, staffId, preFailed);
      completed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      this.logger.error(`Shopee Open API order sync ${batch._id} thất bại: ${message}`);
      await this.orderSync.failBatch(batch, message).catch(() => undefined);
    } finally {
      await this.auth.releaseOrderSyncLock(completed);
    }
  }

  /** All order_sn updated within [from, to] (except UNPAID), walking 15-day windows (API limit) by cursor. */
  private async listOrderSns(batch: ShopeeOrderSyncBatchDocument, from: Date, to: Date): Promise<string[]> {
    const seen = new Set<string>();
    const toS = Math.floor(to.getTime() / 1000);
    for (let start = Math.floor(from.getTime() / 1000); start < toS; start += ORDER_LIST_MAX_RANGE_S) {
      const end = Math.min(start + ORDER_LIST_MAX_RANGE_S, toS);
      let cursor = '';
      for (;;) {
        await this.heartbeat(batch);
        const page = await this.api.getOrderList({ timeFrom: start, timeTo: end, cursor });
        for (const o of page.order_list ?? []) {
          if (o.order_sn && !(o.order_status && SKIPPED_STATUSES.includes(o.order_status))) seen.add(o.order_sn);
        }
        if (!page.more || !page.next_cursor || page.next_cursor === cursor) break;
        cursor = page.next_cursor;
      }
    }
    return Array.from(seen);
  }

  /** Keeps both the order-sync lease and the batch's staleness clock alive. */
  private async heartbeat(batch: ShopeeOrderSyncBatchDocument): Promise<void> {
    await this.auth.extendOrderSyncLock(LOCK_LEASE_MS);
    await this.orderSync.touchBatch(batch._id);
  }

  private async tryTracking(orderSn: string, packageNumber?: string): Promise<string | null> {
    try {
      const res = await this.api.getTrackingNumber(orderSn, packageNumber);
      return res.tracking_number?.trim() || null;
    } catch (err) {
      if (err instanceof ShopeeOpenApiCallError && err.isFatal) throw err;
      return null; // cosmetic: the next run fills it in
    }
  }

  private createBatch(staffId: string, from: Date, to: Date, automatic: boolean): Promise<ShopeeOrderSyncBatchDocument> {
    const fmt = (d: Date) => d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' });
    return this.orderSync.createBatch({
      fileName: `${automatic ? 'Tự động' : 'Shopee API'}: ${fmt(from)} → ${fmt(to)}`,
      staffId,
      source: ShopeeOrderSyncSource.OPEN_API,
    }).then(async (batch) => {
      batch.rangeFrom = from;
      batch.rangeTo = to;
      batch.automatic = automatic;
      return batch.save();
    });
  }

  private assertEnabled(): void {
    if (!this.syncConfig.get().enabled) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.SHOPEE_SYNC_DISABLED, 'Đồng bộ Shopee hiện đang tắt', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}

/** Defaults to the last 7 days; at most 90 days, never in the future. Exported for tests. */
export function resolveRange(range: { from?: string; to?: string }, now = new Date()): { from: Date; to: Date } {
  const to = range.to ? new Date(range.to) : now;
  const from = range.from ? new Date(range.from) : new Date(to.getTime() - DEFAULT_MANUAL_RANGE_DAYS * 86_400_000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw new BadRequestException('Khoảng thời gian không hợp lệ');
  const cappedTo = to.getTime() > now.getTime() ? now : to;
  if (from.getTime() >= cappedTo.getTime()) throw new BadRequestException('"Từ ngày" phải trước "Đến ngày"');
  if (cappedTo.getTime() - from.getTime() > MAX_MANUAL_RANGE_DAYS * 86_400_000) {
    throw new BadRequestException(`Mỗi lần đồng bộ tối đa ${MAX_MANUAL_RANGE_DAYS} ngày`);
  }
  return { from, to: cappedTo };
}
