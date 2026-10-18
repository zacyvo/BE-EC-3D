import { Injectable, Logger } from '@nestjs/common';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import {
  ZBS_ACCESS_TOKEN_INVALID,
  ZBS_CONFIGURATION_CODES,
  ZBS_ERROR_LABELS,
  ZBS_INELIGIBLE_RECIPIENT_CODES,
  ZBS_INVALID_RECIPIENT_CODES,
  ZBS_NIGHT_RESTRICTION_CODE,
  ZBS_RETRYABLE_CODES,
  ZbsErrorClass,
} from './zalo-zbs.constants';

/** Finer reason inside an error class — decides the notification status. */
export type ZbsFailureKind =
  | 'TOKEN_INVALID'
  | 'INVALID_RECIPIENT'
  | 'INELIGIBLE_RECIPIENT'
  | 'NIGHT_RESTRICTION'
  | 'GENERIC';

export type ZbsCallResult<T> =
  | { ok: true; data: T; httpStatus: number; durationMs: number }
  | {
      ok: false;
      errorClass: ZbsErrorClass;
      kind: ZbsFailureKind;
      /** Stable code for history, e.g. ZBS_-118, HTTP_503, TIMEOUT, NETWORK_ENOTFOUND. */
      errorCode: string;
      /** Zalo's numeric `error`, when it answered with one. */
      providerError?: number;
      /** Sanitized — safe to log/persist (never contains a token). */
      description: string;
      httpStatus?: number;
      durationMs: number;
    };

/** POST /message/template `data` (docs: msg_id, sent_time, sending_mode, quota). */
export interface ZbsSendData {
  msg_id?: string;
  sent_time?: string;
  sending_mode?: string;
  quota?: { dailyQuota?: string; remainingQuota?: string };
}

/** GET /template/info/v2 `data`. */
export interface ZbsTemplateInfoData {
  templateId?: string;
  templateName?: string;
  status?: string;
  reason?: string;
  listParams?: Array<{
    name?: string;
    require?: boolean;
    type?: string;
    maxLength?: number;
    minLength?: number;
    acceptNull?: boolean;
  }>;
  listButtons?: unknown[];
  timeout?: number;
  previewUrl?: string;
  templateQuality?: string;
  templateTag?: string;
  price_sdt?: string;
  price?: string;
}

/** GET /message/status `data` (status: -1 not found, 0 not yet delivered, 1 delivered). */
export interface ZbsMessageStatusData {
  delivery_time?: string;
  message?: string;
  status?: number;
}

/** POST oauth.zaloapp.com/v4/oa/access_token (docs: access_token, refresh_token, expires_in). */
export interface ZbsOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. Docs: access token lives 25 h ("90000"). */
  expiresIn: number;
}

export interface ZbsSendRequest {
  phone: string;
  templateId: string;
  templateData: Record<string, string>;
  trackingId: string;
  /** Development mode — only reaches app/OA administrators (CLI test sends only). */
  developmentMode?: boolean;
}

/** Errors raised before any byte reached Zalo — always safe to retry. */
const PRE_CONNECT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const DOCUMENTED_ACCESS_TOKEN_TTL_SECONDS = 90000;

/**
 * Thin client for the documented ZBS endpoints only:
 *   POST {api}/message/template          (gửi tin qua SĐT — permission "Gửi tin qua SĐT")
 *   GET  {api}/template/info/v2          (chi tiết template — permission "Quản lý Message Template")
 *   GET  {api}/message/status            (trạng thái tin SĐT — permission "Gửi tin qua SĐT")
 *   POST {oauth}/v4/oa/access_token      (đổi code / refresh token)
 * Never throws for provider/network errors; every message is sanitized of the tokens used.
 */
@Injectable()
export class ZbsApiClient {
  private readonly logger = new Logger(ZbsApiClient.name);

  constructor(private readonly configService: ZaloZbsConfigService) {}

  sendTemplate(accessToken: string, req: ZbsSendRequest): Promise<ZbsCallResult<ZbsSendData>> {
    const body: Record<string, unknown> = {
      phone: req.phone,
      template_id: req.templateId,
      template_data: req.templateData,
      tracking_id: req.trackingId,
    };
    if (req.developmentMode) body.mode = 'development';
    return this.callBusiness<ZbsSendData>('POST', '/message/template', accessToken, { body, sideEffect: true });
  }

  getTemplateInfo(accessToken: string, templateId: string): Promise<ZbsCallResult<ZbsTemplateInfoData>> {
    return this.callBusiness<ZbsTemplateInfoData>(
      'GET',
      `/template/info/v2?template_id=${encodeURIComponent(templateId)}`,
      accessToken,
      { sideEffect: false },
    );
  }

  getMessageStatus(accessToken: string, messageId: string, phone: string): Promise<ZbsCallResult<ZbsMessageStatusData>> {
    const qs = new URLSearchParams({ message_id: messageId, phone });
    return this.callBusiness<ZbsMessageStatusData>('GET', `/message/status?${qs}`, accessToken, { sideEffect: false });
  }

  /** Refresh: the refresh token is single-use — the caller must persist the returned pair. */
  refreshAccessToken(refreshToken: string): Promise<ZbsCallResult<ZbsOAuthTokens>> {
    const cfg = this.configService.get();
    return this.callOAuth({ refresh_token: refreshToken, app_id: cfg.appId, grant_type: 'refresh_token' }, [refreshToken]);
  }

  /** Authorization code (10-minute, single-use) → token pair. */
  exchangeAuthorizationCode(code: string, codeVerifier?: string): Promise<ZbsCallResult<ZbsOAuthTokens>> {
    const cfg = this.configService.get();
    const form: Record<string, string> = { code, app_id: cfg.appId, grant_type: 'authorization_code' };
    if (codeVerifier) form.code_verifier = codeVerifier;
    return this.callOAuth(form, [code, codeVerifier ?? '']);
  }

  // ─── Business API ────────────────────────────────────────────────────────

  private async callBusiness<T>(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    opts: { body?: Record<string, unknown>; sideEffect: boolean },
  ): Promise<ZbsCallResult<T>> {
    if (!accessToken) {
      return localError('AUTHENTICATION_REQUIRED', 'TOKEN_INVALID', 'ACCESS_TOKEN_MISSING', 'Chưa có access token ZBS');
    }
    const cfg = this.configService.get();
    const sanitize = (s: string) => sanitizeSecrets(s, [accessToken, cfg.appSecret]);
    const label = `${method} ${path.split('?')[0]}`;
    const res = await this.fetchWithTimeout(
      `${cfg.apiBaseUrl}${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json', access_token: accessToken },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      },
      cfg.requestTimeoutMs,
    );
    if (!res.ok) return this.networkFailure<T>(label, res, opts.sideEffect, sanitize);

    const { status: httpStatus, text, durationMs } = res;
    const json = parseObject(text);
    const is2xx = httpStatus >= 200 && httpStatus < 300;
    const providerError = json ? toNumber(json.error) : undefined;

    // Success = HTTP 2xx AND business `error` = 0 (never the Bot API's `ok` field).
    if (is2xx && providerError === 0) {
      return { ok: true, data: (json!.data ?? {}) as T, httpStatus, durationMs };
    }

    if (providerError !== undefined && providerError !== 0) {
      const { errorClass, kind } = classifyProviderError(providerError);
      const desc = String(json!.message ?? ZBS_ERROR_LABELS[providerError] ?? 'ZBS trả về lỗi');
      this.logger.warn(`ZBS ${label}: error ${providerError} (HTTP ${httpStatus}) → ${errorClass}`);
      return {
        ok: false,
        errorClass,
        kind,
        errorCode: `ZBS_${providerError}`,
        providerError,
        description: sanitize(`${desc}${ZBS_ERROR_LABELS[providerError] && desc !== ZBS_ERROR_LABELS[providerError] ? ` — ${ZBS_ERROR_LABELS[providerError]}` : ''}`).slice(0, 500),
        httpStatus,
        durationMs,
      };
    }

    if (is2xx) {
      // 2xx without a recognizable envelope: Zalo took the request — for a send that may mean
      // the message went out, so it is never a clean failure.
      this.logger.warn(`ZBS ${label}: phản hồi 2xx không đúng định dạng`);
      return {
        ok: false,
        errorClass: opts.sideEffect ? 'UNKNOWN_OUTCOME' : 'RETRYABLE',
        kind: 'GENERIC',
        errorCode: 'MALFORMED_RESPONSE',
        description: sanitize(`Phản hồi không đúng định dạng: ${text.slice(0, 200)}`),
        httpStatus,
        durationMs,
      };
    }

    const errorClass = classifyHttpStatus(httpStatus, opts.sideEffect);
    this.logger.warn(`ZBS ${label}: HTTP ${httpStatus} → ${errorClass}`);
    return {
      ok: false,
      errorClass,
      kind: httpStatus === 401 ? 'TOKEN_INVALID' : 'GENERIC',
      errorCode: `HTTP_${httpStatus}`,
      description: sanitize(`HTTP ${httpStatus}: ${text.slice(0, 200)}`),
      httpStatus,
      durationMs,
    };
  }

  // ─── OAuth ───────────────────────────────────────────────────────────────

  private async callOAuth(form: Record<string, string>, extraSecrets: string[]): Promise<ZbsCallResult<ZbsOAuthTokens>> {
    const cfg = this.configService.get();
    if (!cfg.appId || !cfg.appSecret) {
      return localError('CONFIGURATION_REQUIRED', 'GENERIC', 'CONFIG_APP_MISSING', 'Thiếu ZALO_ZBS_APP_ID / ZALO_ZBS_APP_SECRET');
    }
    const secrets = [cfg.appSecret, ...extraSecrets];
    const sanitize = (s: string) => sanitizeSecrets(s, secrets);
    const res = await this.fetchWithTimeout(
      `${cfg.oauthBaseUrl}/v4/oa/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: cfg.appSecret },
        body: new URLSearchParams(form).toString(),
      },
      cfg.requestTimeoutMs,
    );
    // A refresh request that may have reached Zalo may also have consumed the single-use
    // refresh token — so it is UNKNOWN_OUTCOME, not a plain retry.
    if (!res.ok) return this.networkFailure<ZbsOAuthTokens>('OAuth access_token', res, true, sanitize);

    const { status: httpStatus, text, durationMs } = res;
    const json = parseObject(text);
    const accessToken = json && typeof json.access_token === 'string' ? json.access_token : '';
    const refreshToken = json && typeof json.refresh_token === 'string' ? json.refresh_token : '';
    if (httpStatus >= 200 && httpStatus < 300 && accessToken && refreshToken) {
      // Docs table says `expire_in`, the sample says `expires_in` — accept both.
      const exp = toNumber(json!.expires_in ?? json!.expire_in);
      return {
        ok: true,
        data: { accessToken, refreshToken, expiresIn: exp && exp > 0 ? exp : DOCUMENTED_ACCESS_TOKEN_TTL_SECONDS },
        httpStatus,
        durationMs,
      };
    }

    if (httpStatus >= 500) {
      return {
        ok: false,
        errorClass: 'RETRYABLE',
        kind: 'GENERIC',
        errorCode: `HTTP_${httpStatus}`,
        description: sanitize(`OAuth HTTP ${httpStatus}`),
        httpStatus,
        durationMs,
      };
    }
    if (json && (json.error !== undefined || json.error_name !== undefined || json.message !== undefined)) {
      // Zalo answered and refused: the refresh token / code is invalid, expired or used.
      const code = toNumber(json.error);
      const desc = String(json.error_description ?? json.error_reason ?? json.error_name ?? json.message ?? 'OAuth bị từ chối');
      this.logger.warn(`ZBS OAuth: bị từ chối (HTTP ${httpStatus}, error ${code ?? '-'})`);
      return {
        ok: false,
        errorClass: 'AUTHENTICATION_REQUIRED',
        kind: 'TOKEN_INVALID',
        errorCode: code !== undefined ? `OAUTH_${code}` : `OAUTH_HTTP_${httpStatus}`,
        providerError: code,
        description: sanitize(desc).slice(0, 300),
        httpStatus,
        durationMs,
      };
    }
    return {
      ok: false,
      errorClass: 'UNKNOWN_OUTCOME',
      kind: 'GENERIC',
      errorCode: 'OAUTH_MALFORMED_RESPONSE',
      description: sanitize(`OAuth phản hồi không đúng định dạng (HTTP ${httpStatus})`),
      httpStatus,
      durationMs,
    };
  }

  // ─── Transport ───────────────────────────────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<
    | { ok: true; status: number; text: string; durationMs: number }
    | { ok: false; phase: 'connect' | 'read'; err: unknown; status?: number; durationMs: number }
  > {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: controller.signal });
      } catch (err) {
        return { ok: false, phase: 'connect', err, durationMs: Date.now() - started };
      }
      try {
        const text = await res.text();
        return { ok: true, status: res.status, text, durationMs: Date.now() - started };
      } catch (err) {
        return { ok: false, phase: 'read', err, status: res.status, durationMs: Date.now() - started };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private networkFailure<T>(
    label: string,
    res: { phase: 'connect' | 'read'; err: unknown; status?: number; durationMs: number },
    sideEffect: boolean,
    sanitize: (s: string) => string,
  ): ZbsCallResult<T> {
    const { err, durationMs } = res;
    const unknownClass: ZbsErrorClass = sideEffect ? 'UNKNOWN_OUTCOME' : 'RETRYABLE';
    if (res.phase === 'read') {
      // Headers arrived → Zalo received the request and at least started handling it.
      return {
        ok: false,
        errorClass: unknownClass,
        kind: 'GENERIC',
        errorCode: isAbort(err) ? 'TIMEOUT_READING_RESPONSE' : 'RESPONSE_READ_FAILED',
        description: sanitize(`Không đọc được phản hồi ${label}: ${(err as Error)?.message ?? ''}`),
        httpStatus: res.status,
        durationMs,
      };
    }
    if (isAbort(err)) {
      this.logger.warn(`ZBS ${label}: timeout sau ${durationMs}ms → ${unknownClass}`);
      return {
        ok: false,
        errorClass: unknownClass,
        kind: 'GENERIC',
        errorCode: 'TIMEOUT',
        description: `Hết thời gian chờ (${durationMs}ms) — request có thể đã tới Zalo`,
        durationMs,
      };
    }
    const code = errorCodeOf(err);
    const errorClass: ZbsErrorClass = code && PRE_CONNECT_ERROR_CODES.has(code) ? 'RETRYABLE' : unknownClass;
    this.logger.warn(`ZBS ${label}: lỗi mạng ${code ?? ''} → ${errorClass}`);
    return {
      ok: false,
      errorClass,
      kind: 'GENERIC',
      errorCode: `NETWORK_${code ?? 'ERROR'}`,
      description: sanitize(`${(err as Error)?.message ?? 'fetch failed'}${code ? ` (${code})` : ''}`),
      durationMs,
    };
  }
}

/** Official error table → handling class (see zalo-zbs.constants.ts). */
export function classifyProviderError(code: number): { errorClass: ZbsErrorClass; kind: ZbsFailureKind } {
  if (code === ZBS_ACCESS_TOKEN_INVALID) return { errorClass: 'AUTHENTICATION_REQUIRED', kind: 'TOKEN_INVALID' };
  if (ZBS_RETRYABLE_CODES.has(code)) return { errorClass: 'RETRYABLE', kind: 'GENERIC' };
  if (code === ZBS_NIGHT_RESTRICTION_CODE) return { errorClass: 'RETRYABLE', kind: 'NIGHT_RESTRICTION' };
  if (ZBS_INVALID_RECIPIENT_CODES.has(code)) return { errorClass: 'NON_RETRYABLE', kind: 'INVALID_RECIPIENT' };
  if (ZBS_INELIGIBLE_RECIPIENT_CODES.has(code)) return { errorClass: 'NON_RETRYABLE', kind: 'INELIGIBLE_RECIPIENT' };
  if (ZBS_CONFIGURATION_CODES.has(code)) return { errorClass: 'CONFIGURATION_REQUIRED', kind: 'GENERIC' };
  return { errorClass: 'NON_RETRYABLE', kind: 'GENERIC' };
}

/** 429/408/500/502/503 → retry; 504 → may have been processed; 401 → token; other 4xx → refused. */
function classifyHttpStatus(status: number, sideEffect: boolean): ZbsErrorClass {
  if (status === 504) return sideEffect ? 'UNKNOWN_OUTCOME' : 'RETRYABLE';
  if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return 'RETRYABLE';
  if (status === 401) return 'AUTHENTICATION_REQUIRED';
  if (status === 403) return 'CONFIGURATION_REQUIRED';
  return 'NON_RETRYABLE';
}

function localError<T>(errorClass: ZbsErrorClass, kind: ZbsFailureKind, errorCode: string, description: string): ZbsCallResult<T> {
  return { ok: false, errorClass, kind, errorCode, description, durationMs: 0 };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorCodeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Removes every given secret (tokens, app secret, auth code) from a string. */
export function sanitizeSecrets(text: string, secrets: string[]): string {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}
