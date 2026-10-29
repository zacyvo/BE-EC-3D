import { Injectable } from '@nestjs/common';
import { ShopeeOpenApiAuthService } from './shopee-open-api-auth.service';
import { ShopeeErrorClass, ShopeeOpenApiClient } from './shopee-open-api.client';
import { ShopeeOpenApiConfigService } from './shopee-open-api.config';
import type {
  ShopeeEscrowDetailResponse,
  ShopeeItemBaseInfoResponse,
  ShopeeItemExtraInfoResponse,
  ShopeeItemListResponse,
  ShopeeItemStatus,
  ShopeeModelListResponse,
  ShopeeOrderDetailResponse,
  ShopeeOrderListResponse,
  ShopeeTrackingNumberResponse,
} from './shopee-open-api.types';

/** Thrown by ShopeeOpenApiService once retries are exhausted — sync jobs turn it into
 * a per-product/per-order failure or a failed session/batch. */
export class ShopeeOpenApiCallError extends Error {
  constructor(
    readonly errorClass: ShopeeErrorClass | 'NOT_CONNECTED' | 'CONFIG',
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }

  /** The whole job can't continue (vs. one item failing). */
  get isFatal(): boolean {
    return this.errorClass !== 'PERMANENT';
  }
}

const MAX_TRANSIENT_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

/** Max ids per call, per the v2 API reference. */
export const ITEM_ID_BATCH_SIZE = 50;
export const ORDER_SN_BATCH_SIZE = 50;
export const ITEM_LIST_PAGE_SIZE = 100;
export const ORDER_LIST_PAGE_SIZE = 100;
/** get_order_list rejects time ranges longer than 15 days. */
export const ORDER_LIST_MAX_RANGE_S = 15 * 24 * 3600;

const ORDER_DETAIL_OPTIONAL_FIELDS = [
  'buyer_user_id',
  'buyer_username',
  'recipient_address',
  'item_list',
  'total_amount',
  'shipping_carrier',
  'package_list',
  'pay_time',
  'note',
  'cancel_reason',
  'estimated_shipping_fee',
  'actual_shipping_fee',
].join(',');

/**
 * Typed Shopee shop-level API calls with token handling + retries. Every call:
 *  - attaches a fresh access token (refreshing first when needed),
 *  - on AUTH failure refreshes once and retries,
 *  - on RATE_LIMITED / RETRYABLE backs off exponentially (max 3 retries),
 *  - on REAUTH marks the credential REAUTH_REQUIRED so the Admin card prompts a reconnect,
 *  - spaces calls by SHOPEE_OPEN_API_REQUEST_DELAY_MS to stay well under Shopee's QPS caps.
 */
@Injectable()
export class ShopeeOpenApiService {
  private lastCallAt = 0;

  constructor(
    private readonly client: ShopeeOpenApiClient,
    private readonly auth: ShopeeOpenApiAuthService,
    private readonly configService: ShopeeOpenApiConfigService,
  ) {}

  // ─── Product ───────────────────────────────────────────────────────────────

  getItemList(params: { offset: number; pageSize: number; itemStatus: ShopeeItemStatus[]; updateTimeFrom?: number; updateTimeTo?: number }) {
    return this.call<ShopeeItemListResponse>('/api/v2/product/get_item_list', {
      offset: params.offset,
      page_size: params.pageSize,
      item_status: params.itemStatus,
      update_time_from: params.updateTimeFrom,
      update_time_to: params.updateTimeTo,
    });
  }

  getItemBaseInfo(itemIds: string[]) {
    return this.call<ShopeeItemBaseInfoResponse>('/api/v2/product/get_item_base_info', { item_id_list: itemIds.join(',') });
  }

  getModelList(itemId: string) {
    return this.call<ShopeeModelListResponse>('/api/v2/product/get_model_list', { item_id: itemId });
  }

  getItemExtraInfo(itemIds: string[]) {
    return this.call<ShopeeItemExtraInfoResponse>('/api/v2/product/get_item_extra_info', { item_id_list: itemIds.join(',') });
  }

  // ─── Order / logistics / payment ───────────────────────────────────────────

  getOrderList(params: { timeFrom: number; timeTo: number; cursor?: string }) {
    return this.call<ShopeeOrderListResponse>('/api/v2/order/get_order_list', {
      time_range_field: 'update_time',
      time_from: params.timeFrom,
      time_to: params.timeTo,
      page_size: ORDER_LIST_PAGE_SIZE,
      cursor: params.cursor ?? '',
      response_optional_fields: 'order_status',
    });
  }

  getOrderDetail(orderSns: string[]) {
    return this.call<ShopeeOrderDetailResponse>('/api/v2/order/get_order_detail', {
      order_sn_list: orderSns.join(','),
      response_optional_fields: ORDER_DETAIL_OPTIONAL_FIELDS,
    });
  }

  getTrackingNumber(orderSn: string, packageNumber?: string) {
    return this.call<ShopeeTrackingNumberResponse>('/api/v2/logistics/get_tracking_number', {
      order_sn: orderSn,
      package_number: packageNumber,
    });
  }

  getEscrowDetail(orderSn: string) {
    return this.call<ShopeeEscrowDetailResponse>('/api/v2/payment/get_escrow_detail', { order_sn: orderSn });
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  private async call<T>(apiPath: string, params: Record<string, string | number | (string | number)[] | undefined>): Promise<T> {
    let auth = await this.auth.getAccessToken();
    let authRetried = false;
    let transientRetries = 0;

    for (;;) {
      if (!auth.ok) throw new ShopeeOpenApiCallError(auth.errorClass, auth.errorCode, auth.message);
      await this.throttle();
      const res = await this.client.callShop<T>('GET', apiPath, { accessToken: auth.accessToken, shopId: auth.shopId }, params);
      if (res.ok) return res.data;

      if (res.errorClass === 'AUTH' && !authRetried) {
        authRetried = true;
        auth = await this.auth.handleRejectedAccessToken(auth.accessToken);
        continue;
      }
      if ((res.errorClass === 'RATE_LIMITED' || res.errorClass === 'RETRYABLE') && transientRetries < MAX_TRANSIENT_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** transientRetries + Math.floor(Math.random() * 300));
        transientRetries += 1;
        continue;
      }
      if (res.errorClass === 'REAUTH' || (res.errorClass === 'AUTH' && authRetried)) {
        await this.auth.markReauthRequired(res.errorCode, res.message);
        throw new ShopeeOpenApiCallError('REAUTH', res.errorCode, `Shopee từ chối uỷ quyền (${res.errorCode}) — cần kết nối lại`);
      }
      throw new ShopeeOpenApiCallError(res.errorClass, res.errorCode, `${apiPath.replace('/api/v2/', '')}: ${res.errorCode} — ${res.message}`);
    }
  }

  private async throttle(): Promise<void> {
    const gap = this.configService.get().requestDelayMs;
    const wait = this.lastCallAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
