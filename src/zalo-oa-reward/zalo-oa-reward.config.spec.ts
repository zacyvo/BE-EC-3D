import { ConfigService } from '@nestjs/config';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import { LinkMode } from './zalo-oa-reward.constants';

const VALID: Record<string, string> = {
  ZALO_OA_REWARD_ENABLED: 'true',
  ZALO_OA_ID: '388613280879808645',
  ZALO_OA_URL: 'https://zalo.me/388613280879808645',
  ZALO_OA_APP_ID: '36084652489903967',
  ZALO_OA_APP_SECRET: 'app-secret',
  ZALO_OA_WEBHOOK_SECRET: 'oa-secret',
  ZALO_OA_OAUTH_REDIRECT_URI: 'https://api.luxe-glow.vn/api/v1/zalo-oa-reward/oauth/callback',
  ZALO_OA_PROMOTION_ID: '6ad48f1007c02f629c44496a',
  ZALO_OA_COUPON_ID: '6ad48f8007c02f629c4449a3',
  FRONTEND_URL: 'https://luxe-glow.vn',
};

const svc = (env: Record<string, string>) => new ZaloOaRewardConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);

describe('ZaloOaRewardConfigService', () => {
  it('is disabled with empty ENV and never throws', () => {
    const cfg = svc({}).get();
    expect(cfg.enabled).toBe(false);
    expect(cfg.linkMode).toBe(LinkMode.SOCIAL_LOGIN);
    expect(svc({}).validate().valid).toBe(false);
    expect(svc({}).webhookReady()).toBe(false);
  });

  it('accepts the documented production shape and derives the public API base', () => {
    const s = svc(VALID);
    expect(s.validate()).toEqual({ valid: true, errors: [], warnings: [] });
    expect(s.get().publicApiBaseUrl).toBe('https://api.luxe-glow.vn/api/v1');
    expect(s.get().promotionId).toBe('6ad48f1007c02f629c44496a');
    expect(s.get().couponId).toBe('6ad48f8007c02f629c4449a3');
  });

  it('refuses identical promotion and coupon ids (different entities)', () => {
    const v = svc({ ...VALID, ZALO_OA_COUPON_ID: VALID.ZALO_OA_PROMOTION_ID }).validate();
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/khác nhau/);
  });

  it('never falls back to the Zalo Bot or ZBS secrets', () => {
    const env = { ...VALID, ZALO_BOT_WEBHOOK_SECRET: 'bot', ZALO_ZBS_APP_SECRET: 'zbs' };
    delete (env as Record<string, string>).ZALO_OA_WEBHOOK_SECRET;
    delete (env as Record<string, string>).ZALO_OA_APP_SECRET;
    const s = svc(env);
    expect(s.get().webhookSecret).toBe('');
    expect(s.get().appSecret).toBe('');
    expect(s.validate().valid).toBe(false);
    expect(s.webhookReady()).toBe(false);
  });

  it('mini_app mode requires a Mini App id instead of an OAuth redirect', () => {
    const env = { ...VALID, ZALO_OA_LINK_MODE: 'mini_app' };
    delete (env as Record<string, string>).ZALO_OA_OAUTH_REDIRECT_URI;
    expect(svc(env).validate().errors.join()).toMatch(/ZALO_OA_MINI_APP_ID/);
    expect(svc({ ...env, ZALO_OA_MINI_APP_ID: '194839900003483517' }).validate().valid).toBe(true);
  });

  it('webhook readiness only needs app id, OA id and the OA secret', () => {
    expect(svc({ ZALO_OA_ID: VALID.ZALO_OA_ID, ZALO_OA_APP_ID: VALID.ZALO_OA_APP_ID, ZALO_OA_WEBHOOK_SECRET: 's' }).webhookReady()).toBe(true);
  });
});
