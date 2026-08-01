import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ShopeeSyncConfigSnapshot {
  enabled: boolean;
  minimumExtensionVersion: string;
  adapterVersion: string;
  readOnly: true;
  pageSize: number;
  maxPages: number;
  maxProducts: number;
  imageUrlTemplate: string;
  uploadTokenTtlMinutes: number;
  shopId: string;
}

/**
 * Single source of truth for the "kill switch" + tunables described in the feature
 * spec (section 17). Every value is env-driven with a safe default so ops can flip
 * `SHOPEE_SYNC_ENABLED=false` (or bump `SHOPEE_SYNC_MIN_EXTENSION_VERSION`) without a
 * code change or redeploy of the extension.
 *
 * `shopId`: this repo/Shopee shop only has one storefront today, so it is a single
 * configured value rather than something detected per-request. If Luxe Glow ever
 * syncs multiple Shopee shops, this is the one place to turn it into a per-session
 * parameter instead of a global default.
 */
@Injectable()
export class ShopeeSyncConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): ShopeeSyncConfigSnapshot {
    return {
      enabled: this.config.get<string>('SHOPEE_SYNC_ENABLED', 'true') !== 'false',
      minimumExtensionVersion: this.config.get<string>('SHOPEE_SYNC_MIN_EXTENSION_VERSION', '1.0.0'),
      adapterVersion: this.config.get<string>('SHOPEE_SYNC_ADAPTER_VERSION', 'shopee-private-api-v1'),
      readOnly: true,
      pageSize: Number(this.config.get<string>('SHOPEE_SYNC_PAGE_SIZE', '48')),
      maxPages: Number(this.config.get<string>('SHOPEE_SYNC_MAX_PAGES', '30')),
      maxProducts: Number(this.config.get<string>('SHOPEE_SYNC_MAX_PRODUCTS', '5000')),
      imageUrlTemplate: this.config.get<string>(
        'SHOPEE_IMAGE_URL_TEMPLATE',
        'https://down-vn.img.susercontent.com/file/{image_id}',
      ),
      uploadTokenTtlMinutes: Number(this.config.get<string>('SHOPEE_SYNC_UPLOAD_TOKEN_TTL_MINUTES', '25')),
      shopId: this.config.get<string>('SHOPEE_SYNC_DEFAULT_SHOP_ID', 'default'),
    };
  }

  /** Simple MAJOR.MINOR.PATCH comparison — no semver range support needed for this. */
  isExtensionVersionSupported(extensionVersion: string | null | undefined): boolean {
    if (!extensionVersion) return false;
    const min = this.get().minimumExtensionVersion;
    const a = parseVersion(extensionVersion);
    const b = parseVersion(min);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) return true;
      if (a[i] < b[i]) return false;
    }
    return true; // equal
  }
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
