import { createHash, createHmac } from 'crypto';
import {
  appSecretProof,
  computeOaWebhookMac,
  isOpaqueRef,
  newOpaqueRef,
  newPkceVerifier,
  pkceChallenge,
  verifyOaWebhookSignature,
} from './zalo-oa-crypto';

const APP_ID = '36084652489903967';
const SECRET = 'oa-secret-key-xyz';
const BODY = JSON.stringify({ oa_id: '388613280879808645', follower: { id: '24684588352919792' }, user_id_by_app: '552172779717587730', event_name: 'follow', source: 'oa_profile', app_id: APP_ID, timestamp: '1760760000000' });

describe('OA webhook signature (mac = sha256(appId + data + timeStamp + OAsecretKey))', () => {
  const mac = createHash('sha256').update(`${APP_ID}${BODY}1760760000000${SECRET}`).digest('hex');

  it('matches the documented formula', () => {
    expect(computeOaWebhookMac(APP_ID, BODY, '1760760000000', SECRET)).toBe(mac);
  });

  it('accepts the header with or without a "mac=" prefix, any case', () => {
    const base = { appId: APP_ID, rawBody: BODY, timestamp: '1760760000000', oaSecretKey: SECRET };
    expect(verifyOaWebhookSignature({ ...base, header: mac })).toBe(true);
    expect(verifyOaWebhookSignature({ ...base, header: `mac=${mac}` })).toBe(true);
    expect(verifyOaWebhookSignature({ ...base, header: `MAC = ${mac.toUpperCase()}` })).toBe(true);
  });

  it('rejects a tampered body, another secret, another app, another timestamp, garbage', () => {
    const base = { appId: APP_ID, rawBody: BODY, timestamp: '1760760000000', oaSecretKey: SECRET, header: mac };
    expect(verifyOaWebhookSignature({ ...base, rawBody: BODY.replace('24684588352919792', '24684588352919793') })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, oaSecretKey: 'zalo-bot-secret' })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, appId: '1' })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, timestamp: '1760760000001' })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, header: undefined })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, header: 'not-hex' })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, header: mac.slice(0, 60) })).toBe(false);
    expect(verifyOaWebhookSignature({ ...base, oaSecretKey: '' })).toBe(false);
  });
});

describe('PKCE (Zalo OAuth v4)', () => {
  it('verifier: 43 chars with upper, lower and digit, unique per request', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = newPkceVerifier();
      expect(v).toMatch(/^[A-Za-z0-9]{43}$/);
      expect(v).toMatch(/[A-Z]/);
      expect(v).toMatch(/[a-z]/);
      expect(v).toMatch(/[0-9]/);
      seen.add(v);
    }
    expect(seen.size).toBe(200);
  });

  it('challenge = unpadded base64(sha256(ascii(verifier))) — RFC 7636 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('opaque references', () => {
  it('are 256-bit base64url and pass the guard; junk does not', () => {
    const r = newOpaqueRef();
    expect(r).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isOpaqueRef(r)).toBe(true);
    expect(isOpaqueRef('short')).toBe(false);
    expect(isOpaqueRef({ $ne: null })).toBe(false);
    expect(isOpaqueRef('a'.repeat(43) + '"')).toBe(false);
  });
});

describe('appsecret_proof', () => {
  it('is HMAC-SHA256(access_token, app secret) in hex', () => {
    expect(appSecretProof('token', 'secret')).toBe(createHmac('sha256', 'secret').update('token').digest('hex'));
    expect(appSecretProof('token', 'secret')).not.toBe(appSecretProof('token', 'other'));
  });
});
