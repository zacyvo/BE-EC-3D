import { ConfigService } from '@nestjs/config';
import { validateStorefrontUrl, ZaloZbsConfigService } from './zalo-zbs.config';

const make = (env: Record<string, string>) => new ZaloZbsConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);

const VALID = {
  ZALO_ZBS_ENABLED: 'true',
  ZALO_ZBS_APP_ID: '1234567890',
  ZALO_ZBS_APP_SECRET: 'secret-value',
  ZALO_ZBS_REFRESH_TOKEN: 'refresh-value',
  ZALO_ZBS_TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
  ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION: 'tpl1',
  ZALO_ZBS_ORDER_CONFIRMATION_PARAMS: '{"order_code":"orderCode"}',
};

describe('ZaloZbsConfigService', () => {
  it('disabled by default; missing values never throw', () => {
    const svc = make({});
    expect(svc.get().enabled).toBe(false);
    expect(svc.validate().valid).toBe(false);
    expect(svc.get().apiBaseUrl).toBe('https://business.openapi.zalo.me');
  });

  it('valid when every required value is present', () => {
    expect(make(VALID).validate()).toMatchObject({ valid: true, errors: [] });
  });

  it('TEST 04/05: missing credentials or template id are explicit errors', () => {
    const v = make({ ...VALID, ZALO_ZBS_APP_SECRET: '', ZALO_ZBS_TEMPLATE_ORDER_CONFIRMATION: '' }).validate();
    expect(v.valid).toBe(false);
    expect(v.errors.join('|')).toMatch(/APP_SECRET.*\|.*Template ID/);
  });

  it('never uses Zalo Bot variables for ZBS', () => {
    const v = make({ ZALO_ZBS_ENABLED: 'true', ZALO_BOT_TOKEN: 'bot-token', ZALO_BOT_ENABLED: 'true' }).validate();
    expect(v.valid).toBe(false);
    expect(JSON.stringify(make({ ZALO_BOT_TOKEN: 'bot-token' }).get())).not.toContain('bot-token');
  });

  it('rejects a weak encryption key and bad tunables', () => {
    const v = make({ ...VALID, ZALO_ZBS_TOKEN_ENCRYPTION_KEY: 'abc', ZALO_ZBS_MAX_RETRIES: '50', ZALO_ZBS_REQUEST_TIMEOUT_MS: '10' }).validate();
    expect(v.errors.join('|')).toMatch(/ENCRYPTION_KEY.*MAX_RETRIES|ENCRYPTION_KEY/);
    expect(v.errors.some((e) => e.includes('TIMEOUT'))).toBe(true);
    expect(v.errors.some((e) => e.includes('MAX_RETRIES'))).toBe(true);
  });

  it('orderUrl mapping requires a public HTTPS storefront URL', () => {
    const env = { ...VALID, ZALO_ZBS_ORDER_CONFIRMATION_PARAMS: '{"link":"orderUrl"}' };
    expect(make({ ...env, FRONTEND_URL: 'https://luxe-glow.vn' }).validate().valid).toBe(true);
    expect(make({ ...env, ZALO_ZBS_ORDER_URL_BASE: 'https://admin.luxe-glow.vn' }).validate().valid).toBe(false);
  });

  it('readiness exposes booleans, never secrets', () => {
    const r = JSON.stringify(make(VALID).readiness());
    for (const s of ['secret-value', 'refresh-value', 'd'.repeat(64)]) expect(r).not.toContain(s);
  });
});

describe('validateStorefrontUrl', () => {
  it.each([
    ['https://luxe-glow.vn', null],
    ['http://luxe-glow.vn', /HTTPS/],
    ['https://admin.luxe-glow.vn', /Admin/],
    ['https://admin-luxe-glow.vn', /Admin/],
    ['https://luxe-glow.vn/admin', /Admin/],
    ['https://luxe-glow.vn?token=x', /query/],
  ])('%s', (url, expected) => {
    const res = validateStorefrontUrl(url);
    if (expected === null) expect(res).toBeNull();
    else expect(res).toMatch(expected);
  });
});
