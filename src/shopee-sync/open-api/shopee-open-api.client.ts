import { Injectable, Logger } from '@nestjs/common';
import { ShopeeOpenApiConfigService } from './shopee-open-api.config';
import { nowSeconds, signPublic, signShop } from './shopee-open-api.signer';
import type { ShopeeTokenResponse } from './shopee-open-api.types';

/**
 * AUTH         — access token rejected/expired: refresh and retry once.
 * REAUTH       — refresh token / authorization itself rejected: an admin must re-connect the shop.
 * RATE_LIMITED — back off and retry.
 * RETRYABLE    — network / 5xx / Shopee internal error.
 * PERMANENT    — bad params, missing API permission, wrong partner config: retrying won't help.
 */
export type ShopeeErrorClass = 'AUTH' | 'REAUTH' | 'RATE_LIMITED' | 'RETRYABLE' | 'PERMANENT';

export type ShopeeCallResult<T> =
  | { ok: true; data: T; requestId?: string }
  | {
      ok: false;
      errorClass: ShopeeErrorClass;
      /** Shopee's own `error` string (e.g. `error_auth`), or HTTP_xxx / TIMEOUT / NETWORK. */
      errorCode: string;
      /** Sanitized — never contains partner key, tokens or sign. */
      message: string;
      requestId?: string;
    };

type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

export const TOKEN_GET_PATH = '/api/v2/auth/token/get';
export const ACCESS_TOKEN_GET_PATH = '/api/v2/auth/access_token/get';

/**
 * Thin transport for Shopee Open Platform v2: signs every request, unwraps the
 * `{ error, message, request_id, response }` envelope and classifies failures.
 * Never throws for provider/network errors.
 */
@Injectable()
export class ShopeeOpenApiClient {
  private readonly logger = new Logger(ShopeeOpenApiClient.name);

  constructor(private readonly configService: ShopeeOpenApiConfigService) {}

  /** Authorization code (from the auth_partner redirect, single-use, ~10 min) → token pair. */
  getTokenByCode(code: string, shopId: number): Promise<ShopeeCallResult<ShopeeTokenResponse>> {
    const cfg = this.configService.get();
    return this.callPublic(TOKEN_GET_PATH, { code, shop_id: shopId, partner_id: cfg.partnerId }, [code]);
  }

  /** The refresh token rotates: the caller MUST persist the returned pair before anything else. */
  refreshAccessToken(refreshToken: string, shopId: number): Promise<ShopeeCallResult<ShopeeTokenResponse>> {
    const cfg = this.configService.get();
    return this.callPublic(
      ACCESS_TOKEN_GET_PATH,
      { refresh_token: refreshToken, shop_id: shopId, partner_id: cfg.partnerId },
      [refreshToken],
    );
  }

  /** Any shop-level API (product/order/payment/logistics/shop). */
  async callShop<T>(
    method: 'GET' | 'POST',
    apiPath: string,
    auth: { accessToken: string; shopId: number },
    params: Query = {},
  ): Promise<ShopeeCallResult<T>> {
    const cfg = this.configService.get();
    const timestamp = nowSeconds();
    const common: Query = {
      partner_id: cfg.partnerId,
      timestamp,
      access_token: auth.accessToken,
      shop_id: auth.shopId,
      sign: signShop(cfg.partnerId, apiPath, timestamp, auth.accessToken, auth.shopId, cfg.partnerKey),
    };
    const url = `${cfg.host}${apiPath}?${toQueryString(method === 'GET' ? { ...params, ...common } : common)}`;
    const init: RequestInit =
      method === 'GET'
        ? { method }
        : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) };
    return this.send<T>(apiPath, url, init, [auth.accessToken], true);
  }

  private callPublic(apiPath: string, body: Record<string, unknown>, secrets: string[]): Promise<ShopeeCallResult<ShopeeTokenResponse>> {
    const cfg = this.configService.get();
    const timestamp = nowSeconds();
    const qs = toQueryString({ partner_id: cfg.partnerId, timestamp, sign: signPublic(cfg.partnerId, apiPath, timestamp, cfg.partnerKey) });
    return this.send<ShopeeTokenResponse>(
      apiPath,
      `${cfg.host}${apiPath}?${qs}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      secrets,
      false,
    );
  }

  private async send<T>(
    apiPath: string,
    url: string,
    init: RequestInit,
    secrets: string[],
    wrapped: boolean,
  ): Promise<ShopeeCallResult<T>> {
    const cfg = this.configService.get();
    const sanitize = (s: string) => sanitizeSecrets(s, [cfg.partnerKey, ...secrets]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      this.logger.warn(`Shopee ${apiPath}: ${aborted ? 'timeout' : 'lỗi mạng'}`);
      return {
        ok: false,
        errorClass: 'RETRYABLE',
        errorCode: aborted ? 'TIMEOUT' : 'NETWORK',
        message: aborted ? `Hết thời gian chờ Shopee (${cfg.requestTimeoutMs}ms)` : sanitize(`Lỗi mạng: ${(err as Error)?.message ?? ''}`),
      };
    } finally {
      clearTimeout(timer);
    }

    const json = parseObject(text);
    const requestId = typeof json?.request_id === 'string' ? json.request_id : undefined;
    const error = typeof json?.error === 'string' ? json.error : '';

    if (status >= 200 && status < 300 && json && !error) {
      // Shop APIs wrap the payload in `response`; auth (and a few shop) endpoints return it top-level.
      const data = (wrapped && json.response && typeof json.response === 'object' ? json.response : json) as T;
      return { ok: true, data, requestId };
    }

    const message = sanitize(String(json?.message ?? (text.slice(0, 200) || `HTTP ${status}`))).slice(0, 500);
    const errorCode = error || `HTTP_${status}`;
    const errorClass = classifyShopeeError(error, String(json?.message ?? ''), status, apiPath);
    this.logger.warn(`Shopee ${apiPath}: ${errorCode} (HTTP ${status}, request_id ${requestId ?? '-'}) → ${errorClass}`);
    return { ok: false, errorClass, errorCode, message, requestId };
  }
}

/** Exported for unit tests. */
export function classifyShopeeError(error: string, message: string, httpStatus: number, apiPath: string): ShopeeErrorClass {
  const e = error.toLowerCase();
  const m = message.toLowerCase();
  if (httpStatus === 429 || e.includes('too_many') || e.includes('rate_limit')) return 'RATE_LIMITED';
  const isTokenEndpoint = apiPath === TOKEN_GET_PATH || apiPath === ACCESS_TOKEN_GET_PATH;
  if (isTokenEndpoint && (e.includes('auth') || e.includes('param') || e.includes('token') || httpStatus === 401 || httpStatus === 403)) {
    // Code/refresh token invalid, expired or already used — only a new authorization fixes it.
    return httpStatus >= 500 ? 'RETRYABLE' : 'REAUTH';
  }
  if (e.includes('access_token') || m.includes('access_token') || m.includes('access token') || httpStatus === 401) return 'AUTH';
  if (e === 'error_auth' && (m.includes('expire') || m.includes('token'))) return 'AUTH';
  if (e.includes('shop') && (m.includes('authoriz') || m.includes('deauth'))) return 'REAUTH';
  if (httpStatus >= 500 || e.includes('server') || e.includes('inner') || e.includes('busy') || e.includes('system')) return 'RETRYABLE';
  return 'PERMANENT';
}

function toQueryString(params: Query): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    // Shopee expects repeated keys for array params of GET APIs (e.g. item_status=NORMAL&item_status=UNLIST).
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, String(v)));
    else qs.append(key, String(value));
  }
  return qs.toString();
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeSecrets(input: string, secrets: string[]): string {
  let out = input;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}
