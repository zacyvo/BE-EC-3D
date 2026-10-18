import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { LinkMode } from './zalo-oa-reward.constants';

export interface ZaloOaRewardConfigSnapshot {
  /** Master switch. Off by default; the webhook still records follow events while off. */
  enabled: boolean;
  oaId: string;
  /** Public OA page (https://zalo.me/<oa>) the customer is sent to in order to follow. */
  oaUrl: string;
  oaName: string;
  /** The Zalo App linked to the OA. Its app-scoped user id is what OA webhooks report as
   * `user_id_by_app`, and what Zalo Login / Mini App tokens resolve to. */
  appId: string;
  /** Secret — `secret_key` for OAuth v4 and the key of `appsecret_proof`. Never log. */
  appSecret: string;
  /** Secret — the OA Secret Key used in X-ZEvent-Signature. NOT the Zalo Bot secret. */
  webhookSecret: string;
  linkMode: LinkMode;
  /** Registered Zalo Login callback (…/api/v1/zalo-oa-reward/oauth/callback). */
  oauthRedirectUri: string;
  miniAppId: string;
  promotionId: string;
  couponId: string;
  /** Storefront origin for post-Zalo redirects (defaults to FRONTEND_URL). */
  frontendUrl: string;
  /** Public API origin + prefix used to build the connect link (defaults from the
   * redirect URI's origin + /api/v1). */
  publicApiBaseUrl: string;
  orderMaxAgeHours: number;
  linkTtlMinutes: number;
  followTimeoutMinutes: number;
  webhookMaxAgeSeconds: number;
  oauthBaseUrl: string;
  graphBaseUrl: string;
  requestTimeoutMs: number;
}

export interface ZaloOaRewardConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_OAUTH_BASE_URL = 'https://oauth.zaloapp.com';
const DEFAULT_GRAPH_BASE_URL = 'https://graph.zalo.me';
const DIGITS = /^\d{5,32}$/;

/**
 * ZALO_OA_* settings, read from ENV on every call (same approach as the Bot and ZBS
 * config services) so missing values while disabled never crash boot. Shares no variable
 * with ZALO_BOT_* or ZALO_ZBS_*.
 */
@Injectable()
export class ZaloOaRewardConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): ZaloOaRewardConfigSnapshot {
    const oauthRedirectUri = this.str('ZALO_OA_OAUTH_REDIRECT_URI', '');
    const mode = this.str('ZALO_OA_LINK_MODE', LinkMode.SOCIAL_LOGIN).toLowerCase();
    return {
      enabled: this.str('ZALO_OA_REWARD_ENABLED', 'false').toLowerCase() === 'true',
      oaId: this.str('ZALO_OA_ID', ''),
      oaUrl: this.str('ZALO_OA_URL', '').replace(/\/+$/, ''),
      oaName: this.str('ZALO_OA_NAME', 'Luxe Glow'),
      appId: this.str('ZALO_OA_APP_ID', ''),
      appSecret: this.str('ZALO_OA_APP_SECRET', ''),
      webhookSecret: this.str('ZALO_OA_WEBHOOK_SECRET', ''),
      linkMode: mode === LinkMode.MINI_APP ? LinkMode.MINI_APP : LinkMode.SOCIAL_LOGIN,
      oauthRedirectUri,
      miniAppId: this.str('ZALO_OA_MINI_APP_ID', ''),
      promotionId: this.str('ZALO_OA_PROMOTION_ID', ''),
      couponId: this.str('ZALO_OA_COUPON_ID', ''),
      frontendUrl: (this.str('ZALO_OA_REWARD_FRONTEND_URL', '') || this.str('FRONTEND_URL', '')).replace(/\/+$/, ''),
      publicApiBaseUrl: (this.str('ZALO_OA_PUBLIC_API_BASE_URL', '') || apiBaseFromRedirect(oauthRedirectUri)).replace(/\/+$/, ''),
      orderMaxAgeHours: this.num('ZALO_OA_REWARD_ORDER_MAX_AGE_HOURS', 72),
      linkTtlMinutes: this.num('ZALO_OA_REWARD_LINK_TTL_MINUTES', 60),
      followTimeoutMinutes: this.num('ZALO_OA_REWARD_FOLLOW_TIMEOUT_MINUTES', 10),
      webhookMaxAgeSeconds: this.num('ZALO_OA_WEBHOOK_MAX_AGE_SECONDS', 3 * 3600),
      oauthBaseUrl: this.str('ZALO_OA_OAUTH_BASE_URL', DEFAULT_OAUTH_BASE_URL).replace(/\/+$/, '') || DEFAULT_OAUTH_BASE_URL,
      graphBaseUrl: this.str('ZALO_OA_GRAPH_BASE_URL', DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, '') || DEFAULT_GRAPH_BASE_URL,
      requestTimeoutMs: this.num('ZALO_OA_REQUEST_TIMEOUT_MS', 10000),
    };
  }

  /** Everything the customer-facing flow needs. The webhook only needs appId + oaId + secret
   * (see webhookReady) so follow events can be recorded before the reward is switched on. */
  validate(cfg: ZaloOaRewardConfigSnapshot = this.get()): ZaloOaRewardConfigValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!DIGITS.test(cfg.oaId)) errors.push('ZALO_OA_ID thiếu hoặc không phải chuỗi số');
    if (!DIGITS.test(cfg.appId)) errors.push('ZALO_OA_APP_ID thiếu hoặc không phải chuỗi số');
    if (!cfg.appSecret) errors.push('ZALO_OA_APP_SECRET chưa cấu hình');
    if (!cfg.webhookSecret) errors.push('ZALO_OA_WEBHOOK_SECRET chưa cấu hình');
    if (!Types.ObjectId.isValid(cfg.promotionId)) errors.push('ZALO_OA_PROMOTION_ID không hợp lệ');
    if (!Types.ObjectId.isValid(cfg.couponId)) errors.push('ZALO_OA_COUPON_ID không hợp lệ');
    if (cfg.promotionId && cfg.promotionId === cfg.couponId) {
      errors.push('ZALO_OA_PROMOTION_ID và ZALO_OA_COUPON_ID là hai thực thể khác nhau — không được trùng');
    }
    if (!isHttpsUrl(cfg.oaUrl)) errors.push('ZALO_OA_URL thiếu hoặc không phải https URL');
    if (!isHttpUrl(cfg.frontendUrl)) errors.push('ZALO_OA_REWARD_FRONTEND_URL/FRONTEND_URL thiếu');
    if (cfg.linkMode === LinkMode.SOCIAL_LOGIN) {
      if (!isHttpUrl(cfg.oauthRedirectUri)) errors.push('ZALO_OA_OAUTH_REDIRECT_URI thiếu (bắt buộc với ZALO_OA_LINK_MODE=social_login)');
      if (!isHttpUrl(cfg.publicApiBaseUrl)) errors.push('Không xác định được ZALO_OA_PUBLIC_API_BASE_URL');
    } else if (!DIGITS.test(cfg.miniAppId)) {
      errors.push('ZALO_OA_MINI_APP_ID thiếu (bắt buộc với ZALO_OA_LINK_MODE=mini_app)');
    }
    if (cfg.orderMaxAgeHours <= 0) errors.push('ZALO_OA_REWARD_ORDER_MAX_AGE_HOURS phải > 0');
    if (cfg.linkTtlMinutes <= 0) errors.push('ZALO_OA_REWARD_LINK_TTL_MINUTES phải > 0');
    if (cfg.followTimeoutMinutes <= 0) errors.push('ZALO_OA_REWARD_FOLLOW_TIMEOUT_MINUTES phải > 0');
    if (cfg.webhookMaxAgeSeconds < 60) warnings.push('ZALO_OA_WEBHOOK_MAX_AGE_SECONDS quá nhỏ: Zalo retry tới ~2 giờ sau');
    return { valid: errors.length === 0, errors, warnings };
  }

  webhookReady(cfg: ZaloOaRewardConfigSnapshot = this.get()): boolean {
    return !!cfg.webhookSecret && DIGITS.test(cfg.appId) && DIGITS.test(cfg.oaId);
  }

  private str(key: string, fallback: string): string {
    const v = this.config.get<string>(key);
    return v === undefined || v === null ? fallback : String(v).trim();
  }

  private num(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
}

function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(v);
}

function isHttpsUrl(v: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(v);
}

/** https://api.luxe-glow.vn/api/v1/zalo-oa-reward/oauth/callback → https://api.luxe-glow.vn/api/v1 */
function apiBaseFromRedirect(redirectUri: string): string {
  const i = redirectUri.indexOf('/zalo-oa-reward/');
  return i > 0 ? redirectUri.slice(0, i) : '';
}
