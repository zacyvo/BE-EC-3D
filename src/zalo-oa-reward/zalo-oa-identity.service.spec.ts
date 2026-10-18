import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import { ZaloOaIdentityService } from './zalo-oa-identity.service';
import { pkceChallenge } from './zalo-oa-crypto';

const env: Record<string, string> = {
  ZALO_OA_APP_ID: '36084652489903967',
  ZALO_OA_APP_SECRET: 'app-secret-123',
  ZALO_OA_OAUTH_REDIRECT_URI: 'https://api.test/api/v1/zalo-oa-reward/oauth/callback',
  ZALO_OA_OAUTH_BASE_URL: 'https://oauth-mock.test',
  ZALO_OA_GRAPH_BASE_URL: 'https://graph-mock.test',
  ZALO_OA_REQUEST_TIMEOUT_MS: '200',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const svc = () => new ZaloOaIdentityService(new ZaloOaRewardConfigService({ get: (k: string) => env[k] } as unknown as ConfigService));

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ZaloOaIdentityService', () => {
  it('builds the documented v4 permission URL with state and PKCE challenge', () => {
    const url = new URL(svc().buildPermissionUrl('state-abc', 'verifier'));
    expect(url.origin + url.pathname).toBe('https://oauth-mock.test/v4/permission');
    expect(url.searchParams.get('app_id')).toBe(env.ZALO_OA_APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.ZALO_OA_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge('verifier'));
  });

  it('code → access token (secret_key header, form body) → /me with appsecret_proof → id', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (u) =>
      String(u).startsWith('https://oauth-mock.test') ? json({ access_token: 'user-at-1', refresh_token: 'rt', expires_in: '3600' }) : json({ error: 0, message: 'Success', id: '3681046936240438345' }),
    );
    const res = await svc().verifyAuthorizationCode('the-code', 'the-verifier');
    expect(res).toEqual({ ok: true, zaloAppUserId: '3681046936240438345' });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://oauth-mock.test/v4/access_token');
    expect((tokenInit.headers as Record<string, string>).secret_key).toBe('app-secret-123');
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({
      code: 'the-code', app_id: env.ZALO_OA_APP_ID, grant_type: 'authorization_code', code_verifier: 'the-verifier',
    });

    const [meUrl, meInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(meUrl).toBe('https://graph-mock.test/v2.0/me?fields=id');
    const h = meInit.headers as Record<string, string>;
    expect(h.access_token).toBe('user-at-1');
    expect(h.appsecret_proof).toBe(createHmac('sha256', 'app-secret-123').update('user-at-1').digest('hex'));
  });

  it('rejects an OAuth error response without calling /me', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(json({ error: -14002, error_name: 'Invalid code' }));
    expect(await svc().verifyAuthorizationCode('bad', 'v')).toEqual({ ok: false, code: 'OAUTH_EXCHANGE_FAILED', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalid identity proof: /me error or non-numeric id is rejected', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: 452, message: 'Invalid appsecret_proof' }));
    expect(await svc().verifyUserAccessToken('token-from-another-app')).toMatchObject({ ok: false, code: 'IDENTITY_REJECTED' });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: 0, id: 'abc' }));
    expect(await svc().verifyUserAccessToken('t')).toMatchObject({ ok: false, code: 'IDENTITY_REJECTED' });
    expect(await svc().verifyUserAccessToken('')).toMatchObject({ ok: false, code: 'ACCESS_TOKEN_INVALID' });
  });

  it('network failure / timeout / 5xx are reported as retryable, never as an identity', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await svc().verifyUserAccessToken('t')).toEqual({ ok: false, code: 'NETWORK', retryable: true });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    expect(await svc().verifyUserAccessToken('t')).toEqual({ ok: false, code: 'HTTP_502_NON_JSON', retryable: true });
    jest.spyOn(global, 'fetch').mockImplementationOnce((_u, init) => new Promise((_r, reject) =>
      (init as RequestInit).signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    expect(await svc().verifyUserAccessToken('t')).toEqual({ ok: false, code: 'TIMEOUT', retryable: true });
  });
});
