import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotClient, sanitizeSecret } from './zalo-bot.client';

const TOKEN = '1234567890:TEST_TOKEN_should_never_leak';

function makeClient(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = { ZALO_BOT_TOKEN: TOKEN, ZALO_BOT_REQUEST_TIMEOUT_MS: '1000', ...overrides };
  const cfg = new ZaloBotConfigService({ get: (k: string) => env[k] } as unknown as ConfigService);
  return new ZaloBotClient(cfg);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function networkError(code: string): Error {
  const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
  err.cause = { code, message: `connect ${code} bot-api.zaloplatforms.com/bot${TOKEN}/sendMessage` };
  return err;
}

describe('ZaloBotClient', () => {
  let fetchMock: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((msg: unknown) => {
        logged.push(String(msg));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('POSTs JSON {chat_id, text} to /bot{TOKEN}/sendMessage', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: 'm1', date: 1 } }));
    await makeClient().sendMessage('chat-1', 'xin chào');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://bot-api.zaloplatforms.com/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ chat_id: 'chat-1', text: 'xin chào' });
  });

  it('TEST 06: ok=true → success with message_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, result: { message_id: '82599fa32f56d00e8941', date: 1 } }));
    const res = await makeClient().sendMessage('chat-1', 'hi');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.message_id).toBe('82599fa32f56d00e8941');
  });

  it('TEST 07: ok=false → PERMANENT with provider code & description', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { ok: false, error_code: 400, description: 'chat not found' }));
    const res = await makeClient().sendMessage('chat-x', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: 'PERMANENT', errorCode: 'ZALO_400', httpStatus: 400 });
  });

  it('reads camelCase errorCode too; rate limiting (429) is TRANSIENT', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: false, errorCode: 429, message: 'Too many requests' }));
    const res = await makeClient().sendMessage('c', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: 'TRANSIENT', errorCode: 'ZALO_429' });
  });

  it.each([
    [503, 'TRANSIENT'],
    [500, 'TRANSIENT'],
    [429, 'TRANSIENT'],
    [504, 'UNKNOWN'],
    [401, 'PERMANENT'],
    [404, 'PERMANENT'],
  ])('HTTP %s without envelope → %s', async (status, expected) => {
    fetchMock.mockResolvedValue(new Response('<html>error</html>', { status }));
    const res = await makeClient().sendMessage('c', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: expected, errorCode: `HTTP_${status}` });
  });

  it('2xx with unparseable body → UNKNOWN (may have been sent)', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    const res = await makeClient().sendMessage('c', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: 'UNKNOWN', errorCode: 'MALFORMED_RESPONSE' });
  });

  it('TEST 08/21: timeout → UNKNOWN (never classified as safe to retry)', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const res = await makeClient().sendMessage('c', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: 'UNKNOWN', errorCode: 'TIMEOUT' });
  });

  it('DNS / connection-refused failures happen before sending → TRANSIENT', async () => {
    fetchMock.mockRejectedValue(networkError('ENOTFOUND'));
    expect(await makeClient().sendMessage('c', 'hi')).toMatchObject({ errorClass: 'TRANSIENT', errorCode: 'NETWORK_ENOTFOUND' });
    fetchMock.mockRejectedValue(networkError('ECONNREFUSED'));
    expect(await makeClient().sendMessage('c', 'hi')).toMatchObject({ errorClass: 'TRANSIENT' });
  });

  it('connection reset mid-request → UNKNOWN', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNRESET'));
    expect(await makeClient().sendMessage('c', 'hi')).toMatchObject({ errorClass: 'UNKNOWN', errorCode: 'NETWORK_ECONNRESET' });
  });

  it('never leaks the token in results or logs', async () => {
    fetchMock.mockRejectedValue(networkError('ECONNRESET'));
    const res1 = await makeClient().sendMessage('c', 'hi');
    fetchMock.mockResolvedValue(new Response(`upstream error at /bot${TOKEN}/sendMessage`, { status: 502 }));
    const res2 = await makeClient().sendMessage('c', 'hi');
    const all = JSON.stringify([res1, res2]) + logged.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('TEST_TOKEN');
  });

  it('validates text length 1–2000 locally without calling Zalo', async () => {
    const client = makeClient();
    expect(await client.sendMessage('c', '')).toMatchObject({ errorClass: 'VALIDATION', errorCode: 'TEXT_LENGTH_INVALID' });
    expect(await client.sendMessage('c', 'x'.repeat(2001))).toMatchObject({ errorClass: 'VALIDATION' });
    expect(await client.sendMessage('', 'hi')).toMatchObject({ errorClass: 'VALIDATION', errorCode: 'CHAT_ID_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing token → CONFIG error, no network call', async () => {
    const res = await makeClient({ ZALO_BOT_TOKEN: '' }).sendMessage('c', 'hi');
    expect(res).toMatchObject({ ok: false, errorClass: 'CONFIG', errorCode: 'CONFIG_TOKEN_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('testWebhook exposes result.ok/outcome (outer ok alone is not success)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, result: { ok: false, url: 'https://x', outcome: 'webhook.http.403', hint: 'WAF' } }),
    );
    const res = await makeClient().testWebhook();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.ok).toBe(false);
      expect(res.result.outcome).toBe('webhook.http.403');
    }
  });

  it('setWebhook validates URL and secret before calling Zalo', async () => {
    const client = makeClient();
    expect(await client.setWebhook('http://insecure.vn/x', 'a'.repeat(16))).toMatchObject({ errorCode: 'WEBHOOK_URL_INVALID' });
    expect(await client.setWebhook('https://api.luxe-glow.vn/x', 'short')).toMatchObject({ errorCode: 'WEBHOOK_SECRET_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizeSecret masks token occurrences and /bot.../ path segments', () => {
    expect(sanitizeSecret(`x /bot${TOKEN}/getMe y`, TOKEN)).toBe('x /bot***/getMe y');
    expect(sanitizeSecret('see /botABCDEF/sendMessage')).toBe('see /bot***/sendMessage');
  });
});
