import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Opaque, unguessable reference (256 bits, base64url). Used for the connect link and the
 * OAuth state. Only its sha256 is stored. */
export function newOpaqueRef(): string {
  return randomBytes(32).toString('base64url');
}

/** Rejects anything that is not a plausible opaque ref before it reaches a DB query. */
export function isOpaqueRef(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(v);
}

/**
 * Zalo OA webhook signature (docs: "X-ZEvent-Signature: mac = sha256(appId + data + timeStamp
 * + OAsecretKey)", data = the JSON body exactly as sent, timeStamp = its `timestamp` field).
 * The docs do not show whether the header value carries a literal "mac=" prefix, so it is
 * accepted with or without one. Constant-time comparison.
 */
export function computeOaWebhookMac(appId: string, rawBody: string, timestamp: string, oaSecretKey: string): string {
  return sha256Hex(`${appId}${rawBody}${timestamp}${oaSecretKey}`);
}

export function verifyOaWebhookSignature(params: {
  header: string | undefined;
  appId: string;
  rawBody: string;
  timestamp: string;
  oaSecretKey: string;
}): boolean {
  const { header, appId, rawBody, timestamp, oaSecretKey } = params;
  if (!header || !appId || !oaSecretKey || !timestamp) return false;
  const received = header.trim().replace(/^mac\s*=\s*/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = computeOaWebhookMac(appId, rawBody, timestamp, oaSecretKey);
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const ALNUM = UPPER + LOWER + DIGIT;

/** Zalo: "code verifier … có đủ chữ hoa, chữ thường, số và dài 43 ký tự", unique per request. */
export function newPkceVerifier(): string {
  const chars = [UPPER[randomInt(26)], LOWER[randomInt(26)], DIGIT[randomInt(10)]];
  while (chars.length < 43) chars.push(ALNUM[randomInt(ALNUM.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** code_challenge = Base64(SHA-256(ASCII(verifier))) without padding. Zalo's docs say
 * "Base64 … without Padding"; the URL-safe alphabet of RFC 7636 is used (unverified against a
 * live Zalo app — see docs/ZALO_OA_REWARD_INTEGRATION.md §Unverified). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** appsecret_proof = HMAC-SHA256(access_token, app secret), hex (Mini App docs, required
 * since 2024-01-01 when reading a profile server-side). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}
