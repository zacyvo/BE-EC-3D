import { randomBytes, createHash } from 'crypto';

/**
 * Upload tokens are opaque, high-entropy, single-purpose bearer credentials — NOT
 * JWTs (no need for signed claims here since the raw token itself is only ever
 * looked up against one session document). Only the SHA-256 hash is persisted,
 * matching how this repo never stores raw secrets (see `staff.schema.ts` password
 * hashing) — the raw value is returned to the caller exactly once, at creation.
 */
export function generateUploadToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashUploadToken(token) };
}

export function hashUploadToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
