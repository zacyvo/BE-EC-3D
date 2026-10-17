import { ConfigService } from '@nestjs/config';
import { ZaloBotConfigService, parseChatIds, validateWebhookSecret, validateWebhookUrl } from './zalo-bot.config';

function makeConfig(overrides: Record<string, string> = {}): ZaloBotConfigService {
  return new ZaloBotConfigService({
    get: (key: string) => overrides[key],
  } as unknown as ConfigService);
}

describe('ZaloBotConfigService', () => {
  it('is disabled by default with documented defaults and no secrets', () => {
    const cfg = makeConfig().get();
    expect(cfg.enabled).toBe(false);
    expect(cfg.token).toBe('');
    expect(cfg.baseUrl).toBe('https://bot-api.zaloplatforms.com');
    expect(cfg.requestTimeoutMs).toBe(10000);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.ownerChatIds).toEqual([]);
  });

  it('TEST 02: enabled without token → invalid with a clear error, no throw', () => {
    const svc = makeConfig({ ZALO_BOT_ENABLED: 'true' });
    const v = svc.validate();
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toContain('ZALO_BOT_TOKEN');
  });

  it('is valid when enabled with a token (chat ids may come from DB → warning only)', () => {
    const v = makeConfig({ ZALO_BOT_ENABLED: 'true', ZALO_BOT_TOKEN: '123:abc' }).validate();
    expect(v.valid).toBe(true);
    expect(v.warnings.some((w) => w.includes('ZALO_OWNER_CHAT_IDS'))).toBe(true);
  });

  it('rejects out-of-range tunables and a token with path characters', () => {
    const v = makeConfig({
      ZALO_BOT_ENABLED: 'true',
      ZALO_BOT_TOKEN: 'abc/def',
      ZALO_BOT_REQUEST_TIMEOUT_MS: '50',
      ZALO_BOT_MAX_RETRIES: '99',
      ZALO_BOT_BASE_URL: 'http://insecure.example.com',
    }).validate();
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('readiness() never exposes the token or webhook secret', () => {
    const r = makeConfig({
      ZALO_BOT_ENABLED: 'true',
      ZALO_BOT_TOKEN: 'super-secret-token',
      ZALO_BOT_WEBHOOK_SECRET: 'webhook-secret-123',
      ZALO_OWNER_CHAT_IDS: 'a,b',
    }).readiness();
    const json = JSON.stringify(r);
    expect(json).not.toContain('super-secret-token');
    expect(json).not.toContain('webhook-secret-123');
    expect(r.tokenConfigured).toBe(true);
    expect(r.webhookSecretConfigured).toBe(true);
    expect(r.envOwnerChatIdCount).toBe(2);
  });

  it('falls back to ADMIN_URL for the order link, preferring ZALO_BOT_ADMIN_URL', () => {
    expect(makeConfig({ ADMIN_URL: 'https://admin.example.vn/' }).get().adminUrl).toBe('https://admin.example.vn');
    expect(
      makeConfig({ ADMIN_URL: 'https://a.example.vn', ZALO_BOT_ADMIN_URL: 'https://b.example.vn' }).get().adminUrl,
    ).toBe('https://b.example.vn');
  });

  it('parses comma-separated chat ids (trim, dedupe, drop blanks)', () => {
    expect(parseChatIds(' 111 , 222,,111 ')).toEqual(['111', '222']);
  });

  it('validates webhook secret length 8–256 and public https URL', () => {
    expect(validateWebhookSecret('short')).not.toBeNull();
    expect(validateWebhookSecret('a'.repeat(257))).not.toBeNull();
    expect(validateWebhookSecret('a'.repeat(32))).toBeNull();
    expect(validateWebhookUrl('http://api.luxe-glow.vn/x')).not.toBeNull();
    expect(validateWebhookUrl('https://localhost/x')).not.toBeNull();
    expect(validateWebhookUrl('https://192.168.1.2/x')).not.toBeNull();
    expect(validateWebhookUrl('https://api.luxe-glow.vn/api/v1/webhooks/zalo-bot')).toBeNull();
  });
});
