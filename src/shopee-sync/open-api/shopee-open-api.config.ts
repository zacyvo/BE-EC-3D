import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseEncryptionKey } from '../../zalo-zbs/zbs-token-crypto';

export interface ShopeeOpenApiConfigSnapshot {
  partnerId: number;
  partnerKey: string;
  /** Live: https://partner.shopeemobile.com — Sandbox: https://partner.test-stable.shopeemobile.com */
  host: string;
  /** Backend callback Shopee redirects to after the seller authorizes — must be under the
   * "Redirect URL Domain" registered for the app in open.shopee.com console. */
  redirectUrl: string;
  /** Admin page the callback finally sends the browser back to. */
  adminReturnUrl: string;
  tokenEncryptionKey: string;
  requestTimeoutMs: number;
  /** Pause between consecutive Shopee calls of one sync job — stays far below the per-API QPS cap. */
  requestDelayMs: number;
  /** Orders: 0 = auto sync off. */
  orderAutoSyncMinutes: number;
  orderAutoSyncLookbackHours: number;
}

/**
 * Shopee Open Platform v2 (open.shopee.com) — official API, replaces the Chrome Extension
 * (private Seller Center API) + Excel upload once the shop is authorized.
 *
 * Env names `SHOPEE_PARTNER_ID/KEY`, `SHOPEE_API_HOST`, `SHOPEE_REDIRECT_URL` were already
 * reserved in env-BE.example before this module existed — kept as-is.
 */
@Injectable()
export class ShopeeOpenApiConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): ShopeeOpenApiConfigSnapshot {
    const adminUrl = this.str('ADMIN_URL', 'http://localhost:3002').replace(/\/+$/, '');
    return {
      partnerId: Number(this.str('SHOPEE_PARTNER_ID', '0')) || 0,
      partnerKey: this.str('SHOPEE_PARTNER_KEY', ''),
      host: this.str('SHOPEE_API_HOST', 'https://partner.shopeemobile.com').replace(/\/+$/, ''),
      redirectUrl: this.str('SHOPEE_REDIRECT_URL', ''),
      adminReturnUrl: this.str('SHOPEE_OPEN_API_ADMIN_RETURN_URL', '') || `${adminUrl}/integrations/shopee`,
      tokenEncryptionKey: this.str('SHOPEE_TOKEN_ENCRYPTION_KEY', ''),
      requestTimeoutMs: this.num('SHOPEE_OPEN_API_TIMEOUT_MS', 20_000),
      requestDelayMs: this.num('SHOPEE_OPEN_API_REQUEST_DELAY_MS', 200),
      orderAutoSyncMinutes: this.num('SHOPEE_OPEN_API_ORDER_AUTO_SYNC_MINUTES', 0),
      orderAutoSyncLookbackHours: this.num('SHOPEE_OPEN_API_ORDER_AUTO_SYNC_LOOKBACK_HOURS', 48),
    };
  }

  encryptionKey(): Buffer | null {
    return parseEncryptionKey(this.get().tokenEncryptionKey);
  }

  /** Empty = ready to call Shopee. Shown verbatim on the Admin connection card. */
  configErrors(): string[] {
    const cfg = this.get();
    const errors: string[] = [];
    if (!cfg.partnerId) errors.push('Thiếu SHOPEE_PARTNER_ID');
    if (!cfg.partnerKey) errors.push('Thiếu SHOPEE_PARTNER_KEY');
    if (!/^https:\/\//.test(cfg.host)) errors.push('SHOPEE_API_HOST phải là URL https');
    if (!/^https?:\/\//.test(cfg.redirectUrl)) errors.push('Thiếu SHOPEE_REDIRECT_URL (URL callback của backend)');
    if (!this.encryptionKey()) errors.push('SHOPEE_TOKEN_ENCRYPTION_KEY phải là 32 byte (64 ký tự hex hoặc base64)');
    return errors;
  }

  private str(key: string, def: string): string {
    const v = this.config.get<string>(key);
    return v === undefined || v === null ? def : String(v).trim();
  }

  private num(key: string, def: number): number {
    const raw = this.str(key, '');
    const n = Number(raw);
    return raw === '' || !Number.isFinite(n) ? def : n;
  }
}
