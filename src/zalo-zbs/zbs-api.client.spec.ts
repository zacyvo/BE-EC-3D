import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { classifyProviderError, sanitizeSecrets, ZbsApiClient } from './zbs-api.client';

const ACCESS = 'access-token-AAAA-1111';
const SECRET = 'app-secret-SSSS-9999';

function makeClient(env: Record<string, string> = {}) {
  const all: Record<string, string> = {
    ZALO_ZBS_APP_ID: '1234567890',
    ZALO_ZBS_APP_SECRET: SECRET,
    ZALO_ZBS_API_BASE_URL: 'https://zbs-mock.test',
    ZALO_ZBS_OAUTH_BASE_URL: 'https://oauth-mock.test',
    ZALO_ZBS_REQUEST_TIMEOUT_MS: '1000',
    ...env,
  };
  return new ZbsApiClient(new ZaloZbsConfigService({ get: (k: string) => all[k] } as unknown as ConfigService));
}

const req = { phone: '84987654321', templateId: 'tpl1', templateData: { a: 'b' }, trackingId: 'LGOCabc' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ZbsApiClient.sendTemplate', () => {
  it('TEST 10: error=0 + msg_id → ok, with the documented request shape', async () => {
    fetchMock.mockResolvedValue(
      json({
        error: 0,
        message: 'Success',
        data: { msg_id: 'a4d0243f', sent_time: '1626926349402', sending_mode: '1', quota: { dailyQuota: '500', remainingQuota: '499' } },
      }),
    );
    const res = await makeClient().sendTemplate(ACCESS, req);
    expect(res).toMatchObject({ ok: true, data: { msg_id: 'a4d0243f', quota: { remainingQuota: '499' } } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://zbs-mock.test/message/template');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', access_token: ACCESS });
    expect(JSON.parse(init.body)).toEqual({ phone: '84987654321', template_id: 'tpl1', template_data: { a: 'b' }, tracking_id: 'LGOCabc' });
  });

  it('TEST 11: HTTP 200 but error != 0 → NOT success (business error wins)', async () => {
    fetchMock.mockResolvedValue(json({ error: -118, message: 'Zalo account not existed' }));
    const res = await makeClient().sendTemplate(ACCESS, req);
    expect(res).toMatchObject({ ok: false, errorClass: 'NON_RETRYABLE', kind: 'INELIGIBLE_RECIPIENT', errorCode: 'ZBS_-118', providerError: -118 });
  });

  it('does not treat a Bot-style {ok:true} envelope as success', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, result: {} }));
    const res = await makeClient().sendTemplate(ACCESS, req);
    expect(res).toMatchObject({ ok: false, errorClass: 'UNKNOWN_OUTCOME', errorCode: 'MALFORMED_RESPONSE' });
  });

  it('TEST 12: -124 access token invalid → AUTHENTICATION_REQUIRED / TOKEN_INVALID', async () => {
    fetchMock.mockResolvedValue(json({ error: -124, message: 'Access token invalid' }));
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ ok: false, errorClass: 'AUTHENTICATION_REQUIRED', kind: 'TOKEN_INVALID' });
  });

  it.each([
    [-131, 'CONFIGURATION_REQUIRED'], // TEST 15 template not approved
    [-115, 'CONFIGURATION_REQUIRED'], // TEST 16 balance
    [-144, 'CONFIGURATION_REQUIRED'], // TEST 16 daily quota
    [-135, 'CONFIGURATION_REQUIRED'], // TEST 17 OA permission
    [-138, 'CONFIGURATION_REQUIRED'], // TEST 17 app permission
    [-108, 'NON_RETRYABLE'],
    [-1122, 'NON_RETRYABLE'],
    [-100, 'RETRYABLE'],
    [-133, 'RETRYABLE'],
    [-99999, 'NON_RETRYABLE'],
  ])('provider error %i → %s', async (code, cls) => {
    fetchMock.mockResolvedValue(json({ error: code, message: 'x' }));
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ ok: false, errorClass: cls, providerError: code });
  });

  it('TEST 18: timeout → UNKNOWN_OUTCOME (request may have been processed)', async () => {
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          }),
        ),
    );
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ ok: false, errorClass: 'UNKNOWN_OUTCOME', errorCode: 'TIMEOUT' });
  });

  it('pre-connect DNS failure → RETRYABLE; connection reset → UNKNOWN_OUTCOME', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ errorClass: 'RETRYABLE', errorCode: 'NETWORK_ENOTFOUND' });
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ errorClass: 'UNKNOWN_OUTCOME' });
  });

  it.each([
    [503, 'RETRYABLE'],
    [429, 'RETRYABLE'],
    [504, 'UNKNOWN_OUTCOME'],
    [401, 'AUTHENTICATION_REQUIRED'],
    [400, 'NON_RETRYABLE'],
  ])('HTTP %i without envelope → %s', async (status, cls) => {
    fetchMock.mockResolvedValue(new Response('<html>err</html>', { status }));
    expect(await makeClient().sendTemplate(ACCESS, req)).toMatchObject({ ok: false, errorClass: cls });
  });

  it('missing token → AUTHENTICATION_REQUIRED without calling Zalo', async () => {
    expect(await makeClient().sendTemplate('', req)).toMatchObject({ ok: false, errorClass: 'AUTHENTICATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('development mode adds mode=development', async () => {
    fetchMock.mockResolvedValue(json({ error: 0, data: { msg_id: 'x' } }));
    await makeClient().sendTemplate(ACCESS, { ...req, developmentMode: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).mode).toBe('development');
  });

  it('TEST 28: provider text echoing the token is sanitized', async () => {
    fetchMock.mockResolvedValue(json({ error: -132, message: `bad param for token ${ACCESS}` }));
    const res = await makeClient().sendTemplate(ACCESS, req);
    expect(JSON.stringify(res)).not.toContain(ACCESS);
  });
});

describe('ZbsApiClient GET endpoints', () => {
  it('template info: GET /template/info/v2?template_id=…; timeout is RETRYABLE (no side effect)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 0, data: { status: 'ENABLE', listParams: [] } }));
    expect(await makeClient().getTemplateInfo(ACCESS, 'tpl 1')).toMatchObject({ ok: true, data: { status: 'ENABLE' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://zbs-mock.test/template/info/v2?template_id=tpl%201');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 504 }));
    expect(await makeClient().getTemplateInfo(ACCESS, 'tpl1')).toMatchObject({ ok: false, errorClass: 'RETRYABLE' });
  });

  it('message status: GET /message/status?message_id&phone', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 0, data: { status: 1, delivery_time: '1626926349999' } }));
    expect(await makeClient().getMessageStatus(ACCESS, 'm1', '84987654321')).toMatchObject({ ok: true, data: { status: 1 } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://zbs-mock.test/message/status?message_id=m1&phone=84987654321');
  });
});

describe('ZbsApiClient OAuth', () => {
  it('refresh: documented endpoint, form body, secret_key header; parses rotated pair', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'new-access-0001', refresh_token: 'new-refresh-0001', expires_in: '90000' }));
    const res = await makeClient().refreshAccessToken('old-refresh-0001');
    expect(res).toEqual({
      ok: true,
      data: { accessToken: 'new-access-0001', refreshToken: 'new-refresh-0001', expiresIn: 90000 },
      httpStatus: 200,
      durationMs: expect.any(Number),
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth-mock.test/v4/oa/access_token');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', secret_key: SECRET });
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      refresh_token: 'old-refresh-0001',
      app_id: '1234567890',
      grant_type: 'refresh_token',
    });
  });

  it('code exchange sends code, app_id, grant_type and code_verifier', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'a-000001', refresh_token: 'r-000001', expires_in: '90000' }));
    await makeClient().exchangeAuthorizationCode('the-code-123', 'verifier-xyz');
    expect(Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0][1].body))).toEqual({
      code: 'the-code-123',
      app_id: '1234567890',
      grant_type: 'authorization_code',
      code_verifier: 'verifier-xyz',
    });
  });

  it('TEST 14: rejected refresh token → AUTHENTICATION_REQUIRED, secrets sanitized', async () => {
    fetchMock.mockResolvedValue(json({ error: -14014, error_name: 'Invalid refresh token old-refresh-0001' }, 400));
    const res = await makeClient().refreshAccessToken('old-refresh-0001');
    expect(res).toMatchObject({ ok: false, errorClass: 'AUTHENTICATION_REQUIRED', errorCode: 'OAUTH_-14014' });
    expect(JSON.stringify(res)).not.toContain('old-refresh-0001');
  });

  it('refresh timeout → UNKNOWN_OUTCOME (token may already be consumed); 5xx → RETRYABLE', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    expect(await makeClient().refreshAccessToken('r-123456')).toMatchObject({ errorClass: 'RETRYABLE' });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await makeClient().refreshAccessToken('r-123456')).toMatchObject({ errorClass: 'UNKNOWN_OUTCOME' });
  });

  it('missing app credentials → CONFIGURATION_REQUIRED without network', async () => {
    const res = await makeClient({ ZALO_ZBS_APP_SECRET: '' }).refreshAccessToken('r-123456');
    expect(res).toMatchObject({ ok: false, errorClass: 'CONFIGURATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('classifyProviderError covers recipient kinds', () => {
    expect(classifyProviderError(-108)).toEqual({ errorClass: 'NON_RETRYABLE', kind: 'INVALID_RECIPIENT' });
    expect(classifyProviderError(-141)).toEqual({ errorClass: 'NON_RETRYABLE', kind: 'INELIGIBLE_RECIPIENT' });
    expect(classifyProviderError(-133)).toEqual({ errorClass: 'RETRYABLE', kind: 'NIGHT_RESTRICTION' });
  });
  it('sanitizeSecrets ignores very short strings (avoids mangling text)', () => {
    expect(sanitizeSecrets('abc token-123456 def', ['token-123456', 'ab'])).toBe('abc *** def');
  });
});
