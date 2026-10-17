import { Injectable, Logger } from '@nestjs/common';
import { ZaloBotConfigService, validateWebhookSecret, validateWebhookUrl } from './zalo-bot.config';
import { ZALO_MESSAGE_MAX_LENGTH, ZALO_MESSAGE_MIN_LENGTH } from './zalo-bot.constants';

/**
 * How a failed call must be treated by callers:
 * - CONFIG / VALIDATION: rejected locally, nothing was sent — fix config/input, never auto-retry.
 * - TRANSIENT: Zalo did not process the request (connect failure, 429, 5xx) — safe to retry.
 * - PERMANENT: Zalo answered and refused (bad token, bad chat_id, 4xx) — retrying won't help.
 * - UNKNOWN: the request may have been processed (timeout after sending, connection reset,
 *   unparseable 2xx). Never resend automatically — it could duplicate the message.
 */
export type ZaloBotErrorClass = 'CONFIG' | 'VALIDATION' | 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN';

export type ZaloBotCallResult<T> =
  | { ok: true; result: T; httpStatus: number; durationMs: number }
  | {
      ok: false;
      errorClass: ZaloBotErrorClass;
      /** Stable code for history/filters, e.g. TIMEOUT, HTTP_401, ZALO_400, NETWORK_ENOTFOUND. */
      errorCode: string;
      /** Already sanitized — safe to log/persist (never contains the bot token). */
      description: string;
      httpStatus?: number;
      durationMs: number;
    };

/** sendMessage result (docs: { message_id, date }). */
export interface ZaloSendMessageResult {
  message_id?: string;
  date?: number;
}

/** getMe result (docs: { id, account_name, account_type, can_join_groups }). */
export interface ZaloGetMeResult {
  id?: string;
  account_name?: string;
  account_type?: string;
  can_join_groups?: boolean;
}

/** getWebhookInfo result (docs: { url, updated_at }). */
export interface ZaloWebhookInfoResult {
  url?: string;
  updated_at?: number;
}

/** testWebhook result (docs: { ok, url, outcome, hint }) — `result.ok` is what says whether
 * our endpoint answered 2xx; the outer envelope `ok` only means the API call itself worked. */
export interface ZaloTestWebhookResult {
  ok?: boolean;
  url?: string;
  outcome?: string;
  hint?: string;
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

/**
 * Thin client for the official Zalo Bot API:
 *   POST https://bot-api.zaloplatforms.com/bot{BOT_TOKEN}/{METHOD}
 * Only documented methods are implemented (getMe, sendMessage, setWebhook, testWebhook,
 * getWebhookInfo). deleteWebhook / getUpdates are deliberately NOT exposed — switching
 * receive modes must be a manual, explicit operator action.
 *
 * Every result is structured (never throws for provider errors) and every message is
 * passed through `sanitize()` so the token, which lives in the URL path, can never leak
 * into logs, DB rows or API responses.
 */
@Injectable()
export class ZaloBotClient {
  private readonly logger = new Logger(ZaloBotClient.name);

  constructor(private readonly configService: ZaloBotConfigService) {}

  async sendMessage(chatId: string, text: string): Promise<ZaloBotCallResult<ZaloSendMessageResult>> {
    if (!chatId || !String(chatId).trim()) {
      return localError('VALIDATION', 'CHAT_ID_MISSING', 'chat_id trống');
    }
    if (typeof text !== 'string' || text.length < ZALO_MESSAGE_MIN_LENGTH || text.length > ZALO_MESSAGE_MAX_LENGTH) {
      return localError(
        'VALIDATION',
        'TEXT_LENGTH_INVALID',
        `text phải dài ${ZALO_MESSAGE_MIN_LENGTH}–${ZALO_MESSAGE_MAX_LENGTH} ký tự (hiện tại: ${text?.length ?? 0})`,
      );
    }
    return this.call<ZaloSendMessageResult>('sendMessage', { chat_id: String(chatId).trim(), text });
  }

  getMe(): Promise<ZaloBotCallResult<ZaloGetMeResult>> {
    return this.call<ZaloGetMeResult>('getMe', {});
  }

  /** Alias kept for readability at call sites ("is the token + network OK?"). */
  checkBotConnection(): Promise<ZaloBotCallResult<ZaloGetMeResult>> {
    return this.getMe();
  }

  getWebhookInfo(): Promise<ZaloBotCallResult<ZaloWebhookInfoResult>> {
    return this.call<ZaloWebhookInfoResult>('getWebhookInfo', {});
  }

  testWebhook(): Promise<ZaloBotCallResult<ZaloTestWebhookResult>> {
    return this.call<ZaloTestWebhookResult>('testWebhook', {});
  }

  /** Registers the webhook. Only ever invoked from the operator CLI — never automatically. */
  async setWebhook(url: string, secretToken: string): Promise<ZaloBotCallResult<Record<string, unknown>>> {
    const urlErr = validateWebhookUrl(url);
    if (urlErr) return localError('VALIDATION', 'WEBHOOK_URL_INVALID', urlErr);
    const secretErr = validateWebhookSecret(secretToken);
    if (secretErr) return localError('VALIDATION', 'WEBHOOK_SECRET_INVALID', secretErr);
    return this.call<Record<string, unknown>>('setWebhook', { url, secret_token: secretToken });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<ZaloBotCallResult<T>> {
    const cfg = this.configService.get();
    if (!cfg.token) return localError('CONFIG', 'CONFIG_TOKEN_MISSING', 'ZALO_BOT_TOKEN chưa được cấu hình');
    if (/[\s/?#]/.test(cfg.token)) {
      return localError('CONFIG', 'CONFIG_TOKEN_INVALID', 'ZALO_BOT_TOKEN chứa ký tự không hợp lệ');
    }

    const url = `${cfg.baseUrl}/bot${cfg.token}/${method}`;
    const sanitize = (s: string) => sanitizeSecret(s, cfg.token);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        return this.classifyFetchError(method, err, started, sanitize);
      }

      let rawText: string;
      try {
        rawText = await res.text();
      } catch (err) {
        // Headers arrived, so Zalo received and at least started handling the request.
        return {
          ok: false,
          errorClass: 'UNKNOWN',
          errorCode: isAbort(err) ? 'TIMEOUT_READING_RESPONSE' : 'RESPONSE_READ_FAILED',
          description: sanitize(`Không đọc được phản hồi ${method}: ${(err as Error).message}`),
          httpStatus: res.status,
          durationMs: Date.now() - started,
        };
      }

      return this.classifyResponse<T>(method, res.status, rawText, started, sanitize);
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyFetchError<T>(
    method: string,
    err: unknown,
    started: number,
    sanitize: (s: string) => string,
  ): ZaloBotCallResult<T> {
    const durationMs = Date.now() - started;
    if (isAbort(err)) {
      this.logger.warn(`Zalo Bot ${method}: timeout sau ${durationMs}ms — kết quả không xác định`);
      return {
        ok: false,
        errorClass: 'UNKNOWN',
        errorCode: 'TIMEOUT',
        description: `Hết thời gian chờ (${durationMs}ms) — request có thể đã tới Zalo`,
        durationMs,
      };
    }
    const code = errorCodeOf(err);
    const description = sanitize(`${(err as Error)?.message ?? 'fetch failed'}${code ? ` (${code})` : ''}`);
    const errorClass: ZaloBotErrorClass = code && PRE_CONNECT_ERROR_CODES.has(code) ? 'TRANSIENT' : 'UNKNOWN';
    this.logger.warn(`Zalo Bot ${method}: lỗi mạng ${code ?? ''} → ${errorClass}`);
    return { ok: false, errorClass, errorCode: `NETWORK_${code ?? 'ERROR'}`, description, durationMs };
  }

  private classifyResponse<T>(
    method: string,
    httpStatus: number,
    rawText: string,
    started: number,
    sanitize: (s: string) => string,
  ): ZaloBotCallResult<T> {
    const durationMs = Date.now() - started;
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = rawText ? JSON.parse(rawText) : null;
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      json = null;
    }

    const is2xx = httpStatus >= 200 && httpStatus < 300;

    if (json && json.ok === true) {
      return { ok: true, result: (json.result ?? {}) as T, httpStatus, durationMs };
    }

    if (json && json.ok === false) {
      // Undocumented officially; community clients read error_code/description, and the
      // testWebhook page shows a camelCase errorCode for rate limiting — accept both.
      const providerCode = toNumber(json.error_code ?? json.errorCode);
      const providerDesc = String(json.description ?? json.message ?? 'Zalo trả về ok=false');
      const effective = providerCode ?? httpStatus;
      const errorClass = classifyStatus(effective, is2xx ? 'PERMANENT' : undefined);
      this.logger.warn(`Zalo Bot ${method}: ok=false (HTTP ${httpStatus}, code ${providerCode ?? '-'}) → ${errorClass}`);
      return {
        ok: false,
        errorClass,
        errorCode: providerCode !== undefined ? `ZALO_${providerCode}` : `HTTP_${httpStatus}`,
        description: sanitize(providerDesc).slice(0, 500),
        httpStatus,
        durationMs,
      };
    }

    if (is2xx) {
      // 2xx but no recognizable envelope: Zalo accepted the HTTP request, so the message may
      // well have been sent — never treat this as a clean failure.
      this.logger.warn(`Zalo Bot ${method}: phản hồi 2xx không đúng định dạng → UNKNOWN`);
      return {
        ok: false,
        errorClass: 'UNKNOWN',
        errorCode: 'MALFORMED_RESPONSE',
        description: sanitize(`Phản hồi không đúng định dạng: ${rawText.slice(0, 200)}`),
        httpStatus,
        durationMs,
      };
    }

    const errorClass = classifyStatus(httpStatus);
    this.logger.warn(`Zalo Bot ${method}: HTTP ${httpStatus} → ${errorClass}`);
    return {
      ok: false,
      errorClass,
      errorCode: `HTTP_${httpStatus}`,
      description: sanitize(`HTTP ${httpStatus}: ${rawText.slice(0, 200)}`),
      httpStatus,
      durationMs,
    };
  }
}

/** 429 / 408 / 500 / 502 / 503 → retry; 504 (gateway timed out waiting on Zalo) → unknown;
 * every other 4xx → permanent. */
function classifyStatus(status: number, fallback?: ZaloBotErrorClass): ZaloBotErrorClass {
  if (status === 504) return 'UNKNOWN';
  if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return 'TRANSIENT';
  if (status >= 400 && status <= 499) return 'PERMANENT';
  return fallback ?? 'PERMANENT';
}

function localError<T>(errorClass: ZaloBotErrorClass, errorCode: string, description: string): ZaloBotCallResult<T> {
  return { ok: false, errorClass, errorCode, description, durationMs: 0 };
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

/** Removes the token (and any `/bot<...>/` path segment) from a string before it is logged
 * or persisted. Exported for the CLI and tests. */
export function sanitizeSecret(text: string, token?: string): string {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/\/bot[^/\s"']+\//g, '/bot***/');
}
