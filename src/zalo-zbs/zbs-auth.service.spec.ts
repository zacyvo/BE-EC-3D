import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ZbsCredential, ZbsCredentialDocument, ZbsCredentialSchema, ZbsCredentialStatus } from './schemas/zbs-credential.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';

jest.setTimeout(60_000);

const KEY = 'a'.repeat(64);
let mongod: MongoMemoryServer;
let conn: Connection;
let CredModel: Model<ZbsCredentialDocument>;
let env: Record<string, string>;
let fetchMock: jest.SpyInstance;
let oauthCalls: Array<Record<string, string>>;

const tokens = (n: number) => ({ access_token: `access-rotated-${n}`, refresh_token: `refresh-rotated-${n}`, expires_in: '90000' });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function build() {
  const cfg = new ZaloZbsConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);
  return new ZbsAuthService(CredModel, cfg, new ZbsApiClient(cfg));
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? '5.0.19' } });
  conn = await mongoose.createConnection(mongod.getUri()).asPromise();
  CredModel = conn.model(ZbsCredential.name, ZbsCredentialSchema) as unknown as Model<ZbsCredentialDocument>;
  await CredModel.init();
});
afterAll(async () => {
  await conn?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await CredModel.deleteMany({});
  env = {
    ZALO_ZBS_APP_ID: '1234567890',
    ZALO_ZBS_APP_SECRET: 'app-secret-123456',
    ZALO_ZBS_TOKEN_ENCRYPTION_KEY: KEY,
    ZALO_ZBS_REFRESH_TOKEN: 'seed-refresh-000001',
    ZALO_ZBS_OAUTH_BASE_URL: 'https://oauth-mock.test',
    ZALO_ZBS_API_BASE_URL: 'https://zbs-mock.test',
    ZALO_ZBS_REQUEST_TIMEOUT_MS: '1000',
  };
  oauthCalls = [];
  let n = 0;
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
    oauthCalls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
    await new Promise((r) => setTimeout(r, 30));
    return json(tokens(++n));
  });
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ZbsAuthService', () => {
  it('seeds from ENV, stores tokens encrypted, refreshes when no access token is known', async () => {
    const auth = build();
    const res = await auth.getAccessToken();
    expect(res).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    expect(oauthCalls).toEqual([{ refresh_token: 'seed-refresh-000001', app_id: '1234567890', grant_type: 'refresh_token' }]);
    const raw = JSON.stringify(await CredModel.findOne().lean());
    expect(raw).not.toContain('access-rotated-1');
    expect(raw).not.toContain('refresh-rotated-1');
    expect(raw).not.toContain('seed-refresh-000001');
  });

  it('TEST 13: refresh token rotation — the NEW refresh token is used next time, ENV is not re-applied', async () => {
    const auth = build();
    await auth.getAccessToken();
    await CredModel.updateOne({}, { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    expect(await auth.getAccessToken()).toEqual({ ok: true, accessToken: 'access-rotated-2' });
    expect(oauthCalls.map((c) => c.refresh_token)).toEqual(['seed-refresh-000001', 'refresh-rotated-1']);
    // A fresh process (restart) must not fall back to the stale ENV seed.
    await CredModel.updateOne({}, { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    expect(await build().getAccessToken()).toEqual({ ok: true, accessToken: 'access-rotated-3' });
    expect(oauthCalls[2].refresh_token).toBe('refresh-rotated-2');
  });

  it('uses a valid access token without calling OAuth', async () => {
    const auth = build();
    await auth.getAccessToken();
    await auth.getAccessToken();
    expect(oauthCalls).toHaveLength(1);
  });

  it('ENV-seeded access token (unknown expiry) is used until Zalo rejects it, then refreshed (TEST 12)', async () => {
    env.ZALO_ZBS_ACCESS_TOKEN = 'seed-access-000001';
    const auth = build();
    expect(await auth.getAccessToken()).toEqual({ ok: true, accessToken: 'seed-access-000001' });
    expect(oauthCalls).toHaveLength(0);
    expect(await auth.handleRejectedAccessToken('seed-access-000001')).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    // A second worker reporting the same stale token reuses the new one — no second refresh.
    expect(await auth.handleRejectedAccessToken('seed-access-000001')).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    expect(oauthCalls).toHaveLength(1);
  });

  it('concurrent refreshes across instances spend the single-use refresh token exactly once', async () => {
    const a = build();
    const b = build();
    const c = build();
    await a.getAccessToken(); // seed + first refresh
    await CredModel.updateOne({}, { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const results = await Promise.all([a.getAccessToken(), b.getAccessToken(), c.getAccessToken()]);
    expect(oauthCalls).toHaveLength(2);
    expect(results.every((r) => r.ok && r.accessToken === 'access-rotated-2')).toBe(true);
  });

  it('TEST 14: revoked/invalid refresh token → REAUTH_REQUIRED, stops calling OAuth', async () => {
    fetchMock.mockImplementation(async () => json({ error: -14014, error_name: 'Invalid refresh token' }, 400));
    const auth = build();
    expect(await auth.getAccessToken()).toMatchObject({ ok: false, errorClass: 'AUTHENTICATION_REQUIRED', errorCode: 'OAUTH_-14014' });
    expect((await CredModel.findOne().lean())?.status).toBe(ZbsCredentialStatus.REAUTH_REQUIRED);
    fetchMock.mockClear();
    expect(await auth.getAccessToken()).toMatchObject({ ok: false, errorClass: 'AUTHENTICATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-authorization: a NEW ENV refresh token re-seeds and clears REAUTH_REQUIRED', async () => {
    await CredModel.create({ key: 'default', status: ZbsCredentialStatus.REAUTH_REQUIRED, envSeedFingerprint: 'old' });
    env.ZALO_ZBS_REFRESH_TOKEN = 'brand-new-refresh-0002';
    expect(await build().getAccessToken()).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    expect(oauthCalls[0].refresh_token).toBe('brand-new-refresh-0002');
  });

  it('transient OAuth failure → RETRYABLE, refresh token kept, no REAUTH', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
    const auth = build();
    expect(await auth.getAccessToken()).toMatchObject({ ok: false, errorClass: 'RETRYABLE' });
    const doc = await CredModel.findOne().lean();
    expect(doc?.status).toBe(ZbsCredentialStatus.ACTIVE);
    expect(doc?.refreshLockOwner).toBeUndefined();
  });

  it('exchangeAuthorizationCode stores the pair and later refreshes with it', async () => {
    delete env.ZALO_ZBS_REFRESH_TOKEN;
    const auth = build();
    expect(await auth.exchangeAuthorizationCode('code-abcdef', 'verifier-1')).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    expect(oauthCalls[0]).toMatchObject({ code: 'code-abcdef', grant_type: 'authorization_code', code_verifier: 'verifier-1' });
    const view = await auth.statusView();
    expect(view).toMatchObject({ hasCredentials: true, status: 'ACTIVE', source: 'OAUTH_CODE', accessTokenLikelyValid: true });
    expect(JSON.stringify(view)).not.toMatch(/rotated|code-abcdef/);
  });

  it('TEST 04: missing app credentials / encryption key → CONFIGURATION_REQUIRED, no network', async () => {
    env.ZALO_ZBS_TOKEN_ENCRYPTION_KEY = 'short';
    expect(await build().getAccessToken()).toMatchObject({ ok: false, errorClass: 'CONFIGURATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changed encryption key → CONFIGURATION_REQUIRED (TOKEN_DECRYPT_FAILED), not a crash', async () => {
    await build().getAccessToken();
    env.ZALO_ZBS_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(await build().getAccessToken()).toMatchObject({ ok: false, errorCode: 'TOKEN_DECRYPT_FAILED' });
  });
});
