import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM for OA tokens stored in MongoDB. The refresh token rotates on every refresh,
 * so it has to live in the DB (ENV only seeds it) — but never in plaintext.
 * Key = ZALO_ZBS_TOKEN_ENCRYPTION_KEY: 32 bytes as 64 hex chars or base64.
 */
const PREFIX = 'v1';

export function parseEncryptionKey(raw: string): Buffer | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** Throws if the key is wrong or the ciphertext was tampered with. */
export function decryptToken(payload: string, key: Buffer): string {
  const [prefix, iv, tag, enc] = String(payload ?? '').split(':');
  if (prefix !== PREFIX || !iv || !tag || !enc) throw new Error('Định dạng token mã hóa không hợp lệ');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

/** Non-reversible fingerprint (first 16 hex of SHA-256) — lets us detect "ENV token changed"
 * and compare tokens without storing or logging them. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(String(token ?? '')).digest('hex').slice(0, 16);
}
