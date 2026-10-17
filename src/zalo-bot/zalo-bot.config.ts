import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ZaloBotConfigSnapshot {
  /** Master switch for ORDER_CREATED → Zalo notifications. Off by default. */
  enabled: boolean;
  /** Secret — never log, never return from an API. */
  token: string;
  baseUrl: string;
  /** Owner chat ids approved via ENV (comma separated). DB-approved ids are added at runtime. */
  ownerChatIds: string[];
  /** Secret — compared against the X-Bot-Api-Secret-Token header on every webhook call. */
  webhookSecret: string;
  /** Public HTTPS URL registered with setWebhook (informational + used by the CLI). */
  webhookUrl: string;
  requestTimeoutMs: number;
  /** Automatic retries for TRANSIENT failures — total attempts = maxRetries + 1. */
  maxRetries: number;
  retryBaseDelayMs: number;
  /** Worker poll interval. 0 disables the in-process worker on this instance. */
  workerIntervalMs: number;
  /** Admin dashboard origin used to build the "Xem đơn hàng" link. */
  adminUrl: string;
}

export interface ZaloBotConfigValidation {
  /** true when outbound sending can work (enabled + token + sane tunables). */
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Safe-to-expose view of the configuration (admin readiness panel) — booleans instead of
 * secrets, counts instead of chat ids. */
export interface ZaloBotReadiness {
  enabled: boolean;
  tokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  webhookUrl: string;
  baseUrl: string;
  envOwnerChatIdCount: number;
  requestTimeoutMs: number;
  maxRetries: number;
  workerIntervalMs: number;
  adminUrl: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_BASE_URL = 'https://bot-api.zaloplatforms.com';

/**
 * Single source of truth for Zalo Bot settings — same env-driven, safe-default style as
 * ShopeeSyncConfigService. Read on every call (not cached) so a Render env change +
 * restart is the only thing needed to flip the feature, and a missing token while the
 * feature is disabled can never crash boot.
 */
@Injectable()
export class ZaloBotConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): ZaloBotConfigSnapshot {
    return {
      enabled: this.str('ZALO_BOT_ENABLED', 'false').toLowerCase() === 'true',
      token: this.str('ZALO_BOT_TOKEN', ''),
      baseUrl: this.str('ZALO_BOT_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL,
      ownerChatIds: parseChatIds(this.str('ZALO_OWNER_CHAT_IDS', '')),
      webhookSecret: this.str('ZALO_BOT_WEBHOOK_SECRET', ''),
      webhookUrl: this.str('ZALO_BOT_WEBHOOK_URL', ''),
      requestTimeoutMs: this.num('ZALO_BOT_REQUEST_TIMEOUT_MS', 10000),
      maxRetries: this.num('ZALO_BOT_MAX_RETRIES', 3),
      retryBaseDelayMs: this.num('ZALO_BOT_RETRY_BASE_DELAY_MS', 30000),
      workerIntervalMs: this.num('ZALO_BOT_WORKER_INTERVAL_MS', 15000),
      adminUrl: (this.str('ZALO_BOT_ADMIN_URL', '') || this.str('ADMIN_URL', '')).replace(/\/+$/, ''),
    };
  }

  validate(cfg: ZaloBotConfigSnapshot = this.get()): ZaloBotConfigValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!cfg.token) {
      errors.push('ZALO_BOT_TOKEN chưa được cấu hình');
    } else if (/[\s/?#]/.test(cfg.token)) {
      errors.push('ZALO_BOT_TOKEN chứa ký tự không hợp lệ (khoảng trắng, "/", "?" hoặc "#")');
    }

    if (!isHttpsUrl(cfg.baseUrl)) errors.push('ZALO_BOT_BASE_URL phải là URL https hợp lệ');

    if (!Number.isFinite(cfg.requestTimeoutMs) || cfg.requestTimeoutMs < 1000 || cfg.requestTimeoutMs > 60000) {
      errors.push('ZALO_BOT_REQUEST_TIMEOUT_MS phải trong khoảng 1000–60000');
    }
    if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0 || cfg.maxRetries > 10) {
      errors.push('ZALO_BOT_MAX_RETRIES phải là số nguyên 0–10');
    }
    if (!Number.isFinite(cfg.retryBaseDelayMs) || cfg.retryBaseDelayMs < 1000) {
      errors.push('ZALO_BOT_RETRY_BASE_DELAY_MS phải >= 1000');
    }
    if (!Number.isFinite(cfg.workerIntervalMs) || cfg.workerIntervalMs < 0) {
      errors.push('ZALO_BOT_WORKER_INTERVAL_MS phải >= 0');
    } else if (cfg.workerIntervalMs === 0) {
      warnings.push('ZALO_BOT_WORKER_INTERVAL_MS=0 — worker trên instance này bị tắt');
    }

    if (cfg.webhookSecret) {
      const err = validateWebhookSecret(cfg.webhookSecret);
      if (err) errors.push(err);
    } else {
      warnings.push('ZALO_BOT_WEBHOOK_SECRET chưa cấu hình — webhook sẽ từ chối mọi request');
    }

    if (cfg.webhookUrl) {
      const err = validateWebhookUrl(cfg.webhookUrl);
      if (err) errors.push(err);
    }

    if (!cfg.ownerChatIds.length) {
      warnings.push('ZALO_OWNER_CHAT_IDS trống — chỉ gửi tới chat id đã được admin duyệt trong hệ thống');
    }
    if (!cfg.adminUrl) {
      warnings.push('ADMIN_URL / ZALO_BOT_ADMIN_URL chưa cấu hình — tin nhắn sẽ không có link xem đơn');
    } else if (!/^https?:\/\//.test(cfg.adminUrl)) {
      warnings.push('ADMIN_URL / ZALO_BOT_ADMIN_URL không phải URL http(s) — link xem đơn có thể sai');
    }

    if (!cfg.enabled) warnings.push('ZALO_BOT_ENABLED=false — tính năng thông báo đơn hàng đang tắt');

    return { valid: cfg.enabled && errors.length === 0, errors, warnings };
  }

  readiness(): ZaloBotReadiness {
    const cfg = this.get();
    const v = this.validate(cfg);
    return {
      enabled: cfg.enabled,
      tokenConfigured: !!cfg.token,
      webhookSecretConfigured: !!cfg.webhookSecret,
      webhookUrl: cfg.webhookUrl,
      baseUrl: cfg.baseUrl,
      envOwnerChatIdCount: cfg.ownerChatIds.length,
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxRetries: cfg.maxRetries,
      workerIntervalMs: cfg.workerIntervalMs,
      adminUrl: cfg.adminUrl,
      ...v,
    };
  }

  private str(key: string, def: string): string {
    const v = this.config.get<string>(key);
    return v === undefined || v === null ? def : String(v).trim();
  }

  private num(key: string, def: number): number {
    const raw = this.str(key, '');
    return raw === '' ? def : Number(raw);
  }
}

export function parseChatIds(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** setWebhook: secret_token is "8 tới 256 ký tự". */
export function validateWebhookSecret(secret: string): string | null {
  if (secret.length < 8 || secret.length > 256) return 'ZALO_BOT_WEBHOOK_SECRET phải dài 8–256 ký tự';
  if (/\s/.test(secret)) return 'ZALO_BOT_WEBHOOK_SECRET không được chứa khoảng trắng';
  return null;
}

/** setWebhook: URL must be public HTTPS; localhost / 127.0.0.1 / internal IPs are rejected. */
export function validateWebhookUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'ZALO_BOT_WEBHOOK_URL không phải URL hợp lệ';
  }
  if (u.protocol !== 'https:') return 'ZALO_BOT_WEBHOOK_URL phải dùng HTTPS';
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]'
  ) {
    return 'ZALO_BOT_WEBHOOK_URL phải là địa chỉ công khai (không dùng localhost / IP nội bộ)';
  }
  return null;
}
