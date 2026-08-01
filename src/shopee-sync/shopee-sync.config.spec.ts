import { ConfigService } from '@nestjs/config';
import { ShopeeSyncConfigService } from './shopee-sync.config';

function makeConfigService(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
}

describe('ShopeeSyncConfigService', () => {
  it('defaults to enabled=true, readOnly=true and the documented defaults', () => {
    const svc = new ShopeeSyncConfigService(makeConfigService());
    const cfg = svc.get();
    expect(cfg.enabled).toBe(true);
    expect(cfg.readOnly).toBe(true);
    expect(cfg.pageSize).toBe(48);
    expect(cfg.maxPages).toBe(30);
    expect(cfg.maxProducts).toBe(5000);
    expect(cfg.imageUrlTemplate).toContain('{image_id}');
    expect(cfg.videoUrlTemplate).toContain('{video_id}');
    expect(cfg.productUrlTemplate).toBe('https://shopee.vn/{product_slug}-i.{shop_id}.{product_id}');
    expect(cfg.publicShopId).toBe('76624421');
  });

  it('is disabled when SHOPEE_SYNC_ENABLED=false (kill switch)', () => {
    const svc = new ShopeeSyncConfigService(makeConfigService({ SHOPEE_SYNC_ENABLED: 'false' }));
    expect(svc.get().enabled).toBe(false);
  });

  describe('isExtensionVersionSupported', () => {
    it('accepts a version equal to the minimum', () => {
      const svc = new ShopeeSyncConfigService(makeConfigService({ SHOPEE_SYNC_MIN_EXTENSION_VERSION: '1.2.0' }));
      expect(svc.isExtensionVersionSupported('1.2.0')).toBe(true);
    });

    it('accepts a version greater than the minimum (minor and major bumps)', () => {
      const svc = new ShopeeSyncConfigService(makeConfigService({ SHOPEE_SYNC_MIN_EXTENSION_VERSION: '1.2.0' }));
      expect(svc.isExtensionVersionSupported('1.3.0')).toBe(true);
      expect(svc.isExtensionVersionSupported('2.0.0')).toBe(true);
    });

    it('rejects a version older than the minimum', () => {
      const svc = new ShopeeSyncConfigService(makeConfigService({ SHOPEE_SYNC_MIN_EXTENSION_VERSION: '1.2.0' }));
      expect(svc.isExtensionVersionSupported('1.1.9')).toBe(false);
    });

    it('rejects a missing extension version', () => {
      const svc = new ShopeeSyncConfigService(makeConfigService());
      expect(svc.isExtensionVersionSupported(undefined)).toBe(false);
      expect(svc.isExtensionVersionSupported(null)).toBe(false);
      expect(svc.isExtensionVersionSupported('')).toBe(false);
    });

    it('rejects an unparseable version string', () => {
      const svc = new ShopeeSyncConfigService(makeConfigService());
      expect(svc.isExtensionVersionSupported('not-a-version')).toBe(false);
    });
  });
});
