import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseEncryptionKey } from './zbs-token-crypto';
import { parseParamMapping, ZbsParamMapping } from './zbs-template.mapper';
import { parsePromotionParamMapping, ZbsPromotionParamMapping } from './zbs-promotion.mapper';

export interface ZaloZbsConfigSnapshot {
  /** Master switch for ORDER_CREATED → customer ZBS confirmation. Off by default. */
  enabled: boolean;
  appId: string;
  /** Secret — never log, never return from an API. Sent as the `secret_key` header to OAuth. */
  appSecret: string;
  /** Informational (shown in admin, checked against the OAuth callback oa_id). */
  oaId: string;
  /** Optional bootstrap access token. Secret. */
  seedAccessToken: string;
  /** Bootstrap refresh token. Secret. Rotated tokens live encrypted in MongoDB afterwards. */
  seedRefreshToken: string;
  /** Secret — AES-256-GCM key (32 bytes, hex or base64) for tokens stored in MongoDB. */
  tokenEncryptionKey: string;
  templateIdOrderConfirmation: string;
  /** Raw JSON mapping { "<approved param>": "<order source>" | "const:<text>" }. */
  paramMappingRaw: string;
  /** Operator attestation: equals the template id when its ENABLE status and params were
   * checked by hand (used only when the template-info API is not permitted for this app). */
  templateManuallyVerified: string;
  /** Storefront origin for the optional "view order" CTA (defaults to FRONTEND_URL). */
  orderUrlBase: string;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  requestTimeoutMs: number;
  /** Automatic retries for RETRYABLE failures — total attempts = maxRetries + 1. */
  maxRetries: number;
  retryBaseDelayMs: number;
  /** Worker poll interval. 0 disables the in-process worker on this instance. */
  workerIntervalMs: number;
  /** Local safety cap on accepted sends per Vietnam calendar day. 0 = no local cap. */
  dailySendLimit: number;
  /** Optional unit price (VND) for the admin cost ESTIMATE. 0 = use template-info price. */
  unitPriceVnd: number;

  // ── Promotion campaigns (admin-triggered, Tag PROMOTION template) ──
  /** Master switch for admin promotion campaigns. Independent of `enabled` (order confirmation),
   * but shares the app/OA credentials and tokens. Off by default. */
  promotionEnabled: boolean;
  templateIdPromotion: string;
  /** Raw JSON mapping { "<approved param>": "<campaign source>" | "const:<text>" }. */
  promotionParamMappingRaw: string;
  /** Operator attestation for the promotion template (same meaning as templateManuallyVerified). */
  promotionTemplateManuallyVerified: string;
  /** Hard cap on recipients of one campaign. */
  promotionMaxRecipients: number;
  /** Local cap on promotion messages accepted per Vietnam day; the rest wait for the next day. 0 = no cap. */
  promotionDailySendLimit: number;
  /** Promotion messages are only sent between these Vietnam hours: [start, end). */
  promotionSendStartHour: number;
  promotionSendEndHour: number;
}

export interface ZaloZbsConfigValidation {
  /** true when sending can work as far as local config can tell (enabled + all required
   * values present and sane). Template ENABLE status is checked separately at send time. */
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ZaloZbsReadiness {
  enabled: boolean;
  appIdConfigured: boolean;
  appSecretConfigured: boolean;
  oaId: string;
  seedRefreshTokenConfigured: boolean;
  seedAccessTokenConfigured: boolean;
  encryptionKeyConfigured: boolean;
  templateIdConfigured: boolean;
  /** Template id is not secret; shown so the operator can compare with the ZBS portal. */
  templateId: string;
  mappedParams: string[];
  manuallyVerified: boolean;
  orderUrlBase: string;
  apiBaseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  workerIntervalMs: number;
  dailySendLimit: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ZaloZbsPromotionReadiness {
  enabled: boolean;
  templateIdConfigured: boolean;
  templateId: string;
  mappedParams: string[];
  manuallyVerified: boolean;
  maxRecipients: number;
  dailySendLimit: number;
  sendWindow: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_API_BASE_URL = 'https://business.openapi.zalo.me';
const DEFAULT_OAUTH_BASE_URL = 'https://oauth.zaloapp.com';

/**
 * ZBS settings, read from ENV on every call (like ZaloBotConfigService) so a missing value
 * while the feature is disabled can never crash boot. Completely separate from the Bot's
 * ZALO_BOT_* variables — the Bot token is never used for ZBS and vice versa.
 */
@Injectable()
export class ZaloZbsConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): ZaloZbsConfigSnapshot {
    return {
      enabled: this.str('ZALO_ZBS_ENABLED', 'false').toLowerCase() === 'true',
      appId: this.str('ZALO_ZBS_APP_ID', ''),
      appSecret: this.str('ZALO_ZBS_APP_SECRET', ''),
      oaId: this.str('ZALO_ZBS_OA_ID', ''),
      seedAccessToken: this.str('ZALO_ZBS_ACCESS_TOKEN', ''),
      seedRefreshToken: this.str('ZALO_ZBS_REFRESH_TOKEN', ''),
      tokenEncryptionKey: this.str('ZALO_ZBS_TOKEN_ENCRYPTION_KEY', ''),
      templateIdOrderConfirmation: this.str('ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION', ''),
      paramMappingRaw: this.str('ZALO_ZBS_ORDER_CONFIRMATION_PARAMS', ''),
      templateManuallyVerified: this.str('ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED', ''),
      orderUrlBase: (this.str('ZALO_ZBS_ORDER_URL_BASE', '') || this.str('FRONTEND_URL', '')).replace(/\/+$/, ''),
      apiBaseUrl: this.str('ZALO_ZBS_API_BASE_URL', DEFAULT_API_BASE_URL).replace(/\/+$/, '') || DEFAULT_API_BASE_URL,
      oauthBaseUrl: this.str('ZALO_ZBS_OAUTH_BASE_URL', DEFAULT_OAUTH_BASE_URL).replace(/\/+$/, '') || DEFAULT_OAUTH_BASE_URL,
      requestTimeoutMs: this.num('ZALO_ZBS_REQUEST_TIMEOUT_MS', 10000),
      maxRetries: this.num('ZALO_ZBS_MAX_RETRIES', 3),
      retryBaseDelayMs: this.num('ZALO_ZBS_RETRY_BASE_DELAY_MS', 30000),
      workerIntervalMs: this.num('ZALO_ZBS_WORKER_INTERVAL_MS', 15000),
      dailySendLimit: this.num('ZALO_ZBS_DAILY_SEND_LIMIT', 0),
      unitPriceVnd: this.num('ZALO_ZBS_UNIT_PRICE_VND', 0),
      promotionEnabled: this.str('ZALO_ZBS_PROMOTION_ENABLED', 'false').toLowerCase() === 'true',
      templateIdPromotion: this.str('ZALO_ZBS_TEMPLATE_PROMOTION', ''),
      promotionParamMappingRaw: this.str('ZALO_ZBS_PROMOTION_PARAMS', ''),
      promotionTemplateManuallyVerified: this.str('ZALO_ZBS_PROMOTION_TEMPLATE_MANUALLY_VERIFIED', ''),
      promotionMaxRecipients: this.num('ZALO_ZBS_PROMOTION_MAX_RECIPIENTS', 500),
      promotionDailySendLimit: this.num('ZALO_ZBS_PROMOTION_DAILY_SEND_LIMIT', 200),
      promotionSendStartHour: this.num('ZALO_ZBS_PROMOTION_SEND_START_HOUR', 8),
      promotionSendEndHour: this.num('ZALO_ZBS_PROMOTION_SEND_END_HOUR', 21),
    };
  }

  promotionParamMapping(cfg: ZaloZbsConfigSnapshot = this.get()): { mapping: ZbsPromotionParamMapping[]; errors: string[] } {
    return parsePromotionParamMapping(cfg.promotionParamMappingRaw);
  }

  /**
   * Promotion campaigns can be created and sent when this is valid. Needs the shared OAuth
   * config (not ZALO_ZBS_ENABLED, which only governs order confirmations) plus the promotion
   * template, its mapping and sane campaign limits.
   */
  validatePromotion(cfg: ZaloZbsConfigSnapshot = this.get()): ZaloZbsConfigValidation {
    const errors = this.authConfigErrors(cfg);
    const warnings: string[] = [];
    if (!cfg.templateIdPromotion) {
      errors.push('ZALO_ZBS_TEMPLATE_PROMOTION (Template ID khuyến mãi) chưa được cấu hình');
    } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.templateIdPromotion)) {
      errors.push('ZALO_ZBS_TEMPLATE_PROMOTION có ký tự không hợp lệ');
    }
    errors.push(...parsePromotionParamMapping(cfg.promotionParamMappingRaw).errors);
    if (cfg.promotionTemplateManuallyVerified && cfg.promotionTemplateManuallyVerified !== cfg.templateIdPromotion) {
      warnings.push('ZALO_ZBS_PROMOTION_TEMPLATE_MANUALLY_VERIFIED khác Template ID khuyến mãi — bị bỏ qua');
    }
    if (!Number.isInteger(cfg.promotionMaxRecipients) || cfg.promotionMaxRecipients < 1 || cfg.promotionMaxRecipients > 10000) {
      errors.push('ZALO_ZBS_PROMOTION_MAX_RECIPIENTS phải là số nguyên 1–10000');
    }
    if (!Number.isInteger(cfg.promotionDailySendLimit) || cfg.promotionDailySendLimit < 0) {
      errors.push('ZALO_ZBS_PROMOTION_DAILY_SEND_LIMIT phải là số nguyên >= 0');
    }
    const { promotionSendStartHour: start, promotionSendEndHour: end } = cfg;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 7 || end > 22 || start >= end) {
      // Zalo rejects sends between 22h and 7h (-133), so the window must stay inside 7–22.
      errors.push('ZALO_ZBS_PROMOTION_SEND_START_HOUR/END_HOUR phải là giờ nguyên, 7 <= bắt đầu < kết thúc <= 22');
    }
    if (!Number.isFinite(cfg.requestTimeoutMs) || cfg.requestTimeoutMs < 1000 || cfg.requestTimeoutMs > 60000) {
      errors.push('ZALO_ZBS_REQUEST_TIMEOUT_MS phải trong khoảng 1000–60000');
    }
    if (!Number.isFinite(cfg.workerIntervalMs) || cfg.workerIntervalMs < 0) {
      errors.push('ZALO_ZBS_WORKER_INTERVAL_MS phải >= 0');
    }
    if (!cfg.promotionEnabled) warnings.push('ZALO_ZBS_PROMOTION_ENABLED=false — chiến dịch khuyến mãi ZBS đang tắt');
    return { valid: cfg.promotionEnabled && errors.length === 0, errors, warnings };
  }

  promotionReadiness(): ZaloZbsPromotionReadiness {
    const cfg = this.get();
    return {
      enabled: cfg.promotionEnabled,
      templateIdConfigured: !!cfg.templateIdPromotion,
      templateId: cfg.templateIdPromotion,
      mappedParams: parsePromotionParamMapping(cfg.promotionParamMappingRaw).mapping.map((m) => m.param),
      manuallyVerified: !!cfg.promotionTemplateManuallyVerified && cfg.promotionTemplateManuallyVerified === cfg.templateIdPromotion,
      maxRecipients: cfg.promotionMaxRecipients,
      dailySendLimit: cfg.promotionDailySendLimit,
      sendWindow: `${cfg.promotionSendStartHour}h–${cfg.promotionSendEndHour}h`,
      ...this.validatePromotion(cfg),
    };
  }

  paramMapping(cfg: ZaloZbsConfigSnapshot = this.get()): { mapping: ZbsParamMapping[]; errors: string[] } {
    return parseParamMapping(cfg.paramMappingRaw);
  }

  encryptionKey(cfg: ZaloZbsConfigSnapshot = this.get()): Buffer | null {
    return parseEncryptionKey(cfg.tokenEncryptionKey);
  }

  validate(cfg: ZaloZbsConfigSnapshot = this.get()): ZaloZbsConfigValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!cfg.appId) errors.push('ZALO_ZBS_APP_ID chưa được cấu hình');
    else if (!/^\d{1,32}$/.test(cfg.appId)) errors.push('ZALO_ZBS_APP_ID phải là dãy số');
    if (!cfg.appSecret) errors.push('ZALO_ZBS_APP_SECRET chưa được cấu hình');
    if (!cfg.tokenEncryptionKey) {
      errors.push('ZALO_ZBS_TOKEN_ENCRYPTION_KEY chưa được cấu hình (cần để lưu refresh token đã xoay vòng)');
    } else if (!parseEncryptionKey(cfg.tokenEncryptionKey)) {
      errors.push('ZALO_ZBS_TOKEN_ENCRYPTION_KEY phải là 32 byte (64 ký tự hex hoặc base64)');
    }
    if (!cfg.seedRefreshToken) {
      warnings.push('ZALO_ZBS_REFRESH_TOKEN trống — chỉ dùng được nếu token đã được lưu trong DB (CLI exchange-code)');
    }
    for (const [key, value] of [
      ['ZALO_ZBS_ACCESS_TOKEN', cfg.seedAccessToken],
      ['ZALO_ZBS_REFRESH_TOKEN', cfg.seedRefreshToken],
    ] as const) {
      if (value && /\s/.test(value)) errors.push(`${key} chứa khoảng trắng`);
    }

    if (!cfg.templateIdOrderConfirmation) {
      errors.push('ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION (Template ID) chưa được cấu hình');
    } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.templateIdOrderConfirmation)) {
      errors.push('ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION có ký tự không hợp lệ');
    }
    const mapping = parseParamMapping(cfg.paramMappingRaw);
    errors.push(...mapping.errors);
    if (mapping.mapping.some((m) => m.source === 'orderUrl')) {
      const urlErr = validateStorefrontUrl(cfg.orderUrlBase);
      if (urlErr) errors.push(urlErr);
    }
    if (cfg.templateManuallyVerified && cfg.templateManuallyVerified !== cfg.templateIdOrderConfirmation) {
      warnings.push('ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED khác Template ID hiện tại — bị bỏ qua');
    }

    for (const [key, value] of [
      ['ZALO_ZBS_API_BASE_URL', cfg.apiBaseUrl],
      ['ZALO_ZBS_OAUTH_BASE_URL', cfg.oauthBaseUrl],
    ] as const) {
      if (!isHttpsUrl(value)) errors.push(`${key} phải là URL https hợp lệ`);
    }
    if (!Number.isFinite(cfg.requestTimeoutMs) || cfg.requestTimeoutMs < 1000 || cfg.requestTimeoutMs > 60000) {
      errors.push('ZALO_ZBS_REQUEST_TIMEOUT_MS phải trong khoảng 1000–60000');
    }
    if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0 || cfg.maxRetries > 5) {
      errors.push('ZALO_ZBS_MAX_RETRIES phải là số nguyên 0–5');
    }
    if (!Number.isFinite(cfg.retryBaseDelayMs) || cfg.retryBaseDelayMs < 1000) {
      errors.push('ZALO_ZBS_RETRY_BASE_DELAY_MS phải >= 1000');
    }
    if (!Number.isFinite(cfg.workerIntervalMs) || cfg.workerIntervalMs < 0) {
      errors.push('ZALO_ZBS_WORKER_INTERVAL_MS phải >= 0');
    } else if (cfg.workerIntervalMs === 0) {
      warnings.push('ZALO_ZBS_WORKER_INTERVAL_MS=0 — worker ZBS trên instance này bị tắt');
    }
    if (!Number.isInteger(cfg.dailySendLimit) || cfg.dailySendLimit < 0) {
      errors.push('ZALO_ZBS_DAILY_SEND_LIMIT phải là số nguyên >= 0');
    }
    if (!Number.isFinite(cfg.unitPriceVnd) || cfg.unitPriceVnd < 0) {
      errors.push('ZALO_ZBS_UNIT_PRICE_VND phải >= 0');
    }

    if (!cfg.enabled) warnings.push('ZALO_ZBS_ENABLED=false — tin xác nhận đơn hàng ZBS đang tắt');
    return { valid: cfg.enabled && errors.length === 0, errors, warnings };
  }

  /** True when the OAuth calls (refresh / code exchange) can be attempted — independent of
   * ZALO_ZBS_ENABLED so the operator can authorize and verify the template before enabling. */
  authConfigErrors(cfg: ZaloZbsConfigSnapshot = this.get()): string[] {
    const errors: string[] = [];
    if (!cfg.appId) errors.push('ZALO_ZBS_APP_ID chưa được cấu hình');
    if (!cfg.appSecret) errors.push('ZALO_ZBS_APP_SECRET chưa được cấu hình');
    if (!parseEncryptionKey(cfg.tokenEncryptionKey)) errors.push('ZALO_ZBS_TOKEN_ENCRYPTION_KEY chưa hợp lệ');
    if (!isHttpsUrl(cfg.oauthBaseUrl)) errors.push('ZALO_ZBS_OAUTH_BASE_URL phải là URL https hợp lệ');
    if (!isHttpsUrl(cfg.apiBaseUrl)) errors.push('ZALO_ZBS_API_BASE_URL phải là URL https hợp lệ');
    return errors;
  }

  readiness(): ZaloZbsReadiness {
    const cfg = this.get();
    const v = this.validate(cfg);
    return {
      enabled: cfg.enabled,
      appIdConfigured: !!cfg.appId,
      appSecretConfigured: !!cfg.appSecret,
      oaId: cfg.oaId,
      seedRefreshTokenConfigured: !!cfg.seedRefreshToken,
      seedAccessTokenConfigured: !!cfg.seedAccessToken,
      encryptionKeyConfigured: !!parseEncryptionKey(cfg.tokenEncryptionKey),
      templateIdConfigured: !!cfg.templateIdOrderConfirmation,
      templateId: cfg.templateIdOrderConfirmation,
      mappedParams: parseParamMapping(cfg.paramMappingRaw).mapping.map((m) => m.param),
      manuallyVerified: !!cfg.templateManuallyVerified && cfg.templateManuallyVerified === cfg.templateIdOrderConfirmation,
      orderUrlBase: cfg.orderUrlBase,
      apiBaseUrl: cfg.apiBaseUrl,
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxRetries: cfg.maxRetries,
      workerIntervalMs: cfg.workerIntervalMs,
      dailySendLimit: cfg.dailySendLimit,
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The customer CTA must point at the public storefront — never the admin dashboard. */
export function validateStorefrontUrl(url: string): string | null {
  if (!url) return 'orderUrl được map nhưng chưa cấu hình ZALO_ZBS_ORDER_URL_BASE / FRONTEND_URL';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'ZALO_ZBS_ORDER_URL_BASE không phải URL hợp lệ';
  }
  if (u.protocol !== 'https:') return 'ZALO_ZBS_ORDER_URL_BASE phải dùng HTTPS';
  if (/(^|\.)admin[.-]|admin\./i.test(u.hostname) || /\/admin(\/|$)/i.test(u.pathname)) {
    return 'ZALO_ZBS_ORDER_URL_BASE không được trỏ tới trang Admin';
  }
  if (u.search || u.hash) return 'ZALO_ZBS_ORDER_URL_BASE không được chứa query/hash (tránh lộ token)';
  return null;
}
