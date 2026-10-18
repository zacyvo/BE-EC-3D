import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { ZbsCredential, ZbsCredentialDocument, ZbsCredentialStatus } from './schemas/zbs-credential.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient, ZbsOAuthTokens } from './zbs-api.client';
import { ZbsErrorClass } from './zalo-zbs.constants';
import { decryptToken, encryptToken, tokenFingerprint } from './zbs-token-crypto';

export const ZBS_CREDENTIAL_KEY = 'default';

/** Refresh this long before the access token's documented expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Docs: refresh token valid 3 months from issue (estimate shown in admin only). */
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
const LOCK_POLL_MS = 250;

export type ZbsAuthResult =
  | { ok: true; accessToken: string }
  | { ok: false; errorClass: ZbsErrorClass; errorCode: string; description: string };

export interface ZbsCredentialStatusView {
  hasCredentials: boolean;
  status: ZbsCredentialStatus | 'NONE';
  source?: string;
  accessTokenExpiresAt?: Date | null;
  accessTokenLikelyValid: boolean;
  refreshTokenObtainedAt?: Date;
  /** Estimate: obtained + 3 months (docs). Re-authorize before this. */
  refreshTokenExpiresAtEstimate?: Date;
  lastRefreshAt?: Date;
  lastRefreshErrorCode?: string;
  lastRefreshErrorMessage?: string;
  refreshInProgress: boolean;
  envSeedPending: boolean;
}

/**
 * OA access/refresh token lifecycle (docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new):
 * access token 25 h; refresh token 3 months, SINGLE-USE — each refresh returns a new pair
 * and invalidates the old refresh token (and the old access token).
 *
 * Consequences implemented here:
 *  - ENV tokens only SEED the DB row; after the first refresh the DB row (encrypted) is the
 *    truth. Changing the ENV refresh token (re-authorization) re-seeds the row.
 *  - Only one process may spend the refresh token: a DB lease (`refreshLock*`) serializes
 *    refreshes across workers/instances; losers wait and reuse the winner's token.
 *  - The new pair is written unconditionally the moment Zalo returns it — losing it would
 *    force a manual re-authorization.
 *  - A rejected refresh → REAUTH_REQUIRED; sending stops (AUTHENTICATION_REQUIRED) until an
 *    operator re-authorizes. Tokens are never logged or returned by any API.
 */
@Injectable()
export class ZbsAuthService {
  private readonly logger = new Logger(ZbsAuthService.name);
  readonly ownerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

  constructor(
    @InjectModel(ZbsCredential.name) private readonly credentialModel: Model<ZbsCredentialDocument>,
    private readonly configService: ZaloZbsConfigService,
    private readonly client: ZbsApiClient,
  ) {}

  /** A usable access token, refreshing it first when expired. Never throws. */
  async getAccessToken(): Promise<ZbsAuthResult> {
    try {
      const pre = this.precheck();
      if (pre) return pre;
      const doc = await this.loadOrSeed();
      if (!doc) {
        return fail('AUTHENTICATION_REQUIRED', 'NO_CREDENTIALS', 'Chưa có token OA — cấu hình ZALO_ZBS_REFRESH_TOKEN hoặc chạy CLI exchange-code');
      }
      if (doc.status === ZbsCredentialStatus.REAUTH_REQUIRED) {
        return fail('AUTHENTICATION_REQUIRED', doc.lastRefreshErrorCode ?? 'REAUTH_REQUIRED', 'Refresh token bị từ chối — cần ủy quyền lại OA');
      }
      if (doc.accessTokenEnc && isAccessTokenFresh(doc)) {
        return { ok: true, accessToken: this.decrypt(doc.accessTokenEnc) };
      }
      return this.refresh({ force: false });
    } catch (err) {
      return this.internalFailure(err);
    }
  }

  /** Called after the API answered "access token invalid" (-124) for `usedToken`. Refreshes
   * unless another worker already replaced that token. */
  async handleRejectedAccessToken(usedToken: string): Promise<ZbsAuthResult> {
    try {
      const pre = this.precheck();
      if (pre) return pre;
      const doc = await this.credentialModel.findOne({ key: ZBS_CREDENTIAL_KEY }).exec();
      if (doc?.accessTokenEnc) {
        const current = this.decrypt(doc.accessTokenEnc);
        if (tokenFingerprint(current) !== tokenFingerprint(usedToken) && isAccessTokenFresh(doc)) {
          return { ok: true, accessToken: current };
        }
      }
      return this.refresh({ force: true, rejectedFingerprint: tokenFingerprint(usedToken) });
    } catch (err) {
      return this.internalFailure(err);
    }
  }

  /** Admin/CLI: refresh now (spends the refresh token — the new pair is persisted). */
  async forceRefresh(): Promise<ZbsAuthResult> {
    try {
      const pre = this.precheck();
      if (pre) return pre;
      const doc = await this.loadOrSeed();
      if (!doc?.refreshTokenEnc) return fail('AUTHENTICATION_REQUIRED', 'NO_CREDENTIALS', 'Chưa có refresh token');
      return this.refresh({ force: true });
    } catch (err) {
      return this.internalFailure(err);
    }
  }

  /** CLI: authorization code (10 min, single-use) from the OA authorization callback → tokens. */
  async exchangeAuthorizationCode(code: string, codeVerifier?: string): Promise<ZbsAuthResult> {
    try {
      const pre = this.precheck();
      if (pre) return pre;
      const res = await this.client.exchangeAuthorizationCode(code, codeVerifier);
      if (!res.ok) return fail(res.errorClass, res.errorCode, res.description);
      await this.persistTokens(res.data, 'OAUTH_CODE');
      this.logger.log('ZBS: đã lưu token OA mới từ authorization code');
      return { ok: true, accessToken: res.data.accessToken };
    } catch (err) {
      return this.internalFailure(err);
    }
  }

  async statusView(): Promise<ZbsCredentialStatusView> {
    const cfg = this.configService.get();
    const doc = await this.credentialModel.findOne({ key: ZBS_CREDENTIAL_KEY }).lean().exec();
    const envSeedPending =
      !!cfg.seedRefreshToken && (!doc || doc.envSeedFingerprint !== this.envSeedFingerprint());
    if (!doc) {
      return { hasCredentials: false, status: 'NONE', accessTokenLikelyValid: false, refreshInProgress: false, envSeedPending };
    }
    const now = Date.now();
    return {
      hasCredentials: !!doc.refreshTokenEnc,
      status: doc.status,
      source: doc.source,
      accessTokenExpiresAt: doc.accessTokenExpiresAt ?? null,
      accessTokenLikelyValid: !!doc.accessTokenEnc && isAccessTokenFresh(doc),
      refreshTokenObtainedAt: doc.refreshTokenObtainedAt,
      refreshTokenExpiresAtEstimate: doc.refreshTokenObtainedAt
        ? new Date(new Date(doc.refreshTokenObtainedAt).getTime() + REFRESH_TOKEN_TTL_MS)
        : undefined,
      lastRefreshAt: doc.lastRefreshAt,
      lastRefreshErrorCode: doc.lastRefreshErrorCode,
      lastRefreshErrorMessage: doc.lastRefreshErrorMessage,
      refreshInProgress: !!doc.refreshLockUntil && new Date(doc.refreshLockUntil).getTime() > now,
      envSeedPending,
    };
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private precheck(): ZbsAuthResult | null {
    const errors = this.configService.authConfigErrors();
    return errors.length ? fail('CONFIGURATION_REQUIRED', 'CONFIG_AUTH_INVALID', errors.join('; ')) : null;
  }

  private envSeedFingerprint(): string {
    const cfg = this.configService.get();
    return tokenFingerprint(`${cfg.seedRefreshToken}|${cfg.seedAccessToken}`);
  }

  /** Returns the credential row, (re)seeding it from ENV when the ENV tokens are new. */
  private async loadOrSeed(): Promise<ZbsCredentialDocument | null> {
    const cfg = this.configService.get();
    if (cfg.seedRefreshToken) {
      const fp = this.envSeedFingerprint();
      const key = this.encryptionKey();
      const $set: Record<string, unknown> = {
        status: ZbsCredentialStatus.ACTIVE,
        source: 'ENV',
        envSeedFingerprint: fp,
        refreshTokenEnc: encryptToken(cfg.seedRefreshToken, key),
        refreshTokenObtainedAt: new Date(),
      };
      const $unset: Record<string, 1> = { lastRefreshErrorCode: 1, lastRefreshErrorMessage: 1, accessTokenExpiresAt: 1 };
      if (cfg.seedAccessToken) $set.accessTokenEnc = encryptToken(cfg.seedAccessToken, key);
      else $unset.accessTokenEnc = 1;
      try {
        // Only when the ENV seed differs from what this row was seeded/authorized with —
        // never overwrites a rotated token with the stale ENV one.
        const res = await this.credentialModel
          .updateOne({ key: ZBS_CREDENTIAL_KEY, envSeedFingerprint: { $ne: fp } }, { $set, $unset }, { upsert: true })
          .exec();
        if (res.modifiedCount || res.upsertedCount) this.logger.log('ZBS: đã nạp token OA từ ENV vào DB (mã hóa)');
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // concurrent seed — row exists
      }
    }
    return this.credentialModel.findOne({ key: ZBS_CREDENTIAL_KEY }).exec();
  }

  private async refresh(opts: { force: boolean; rejectedFingerprint?: string }): Promise<ZbsAuthResult> {
    const cfg = this.configService.get();
    const leaseMs = cfg.requestTimeoutMs + 15_000;
    const deadline = Date.now() + leaseMs + 5_000;

    // 1. Acquire the refresh lock — or wait for whoever holds it and reuse their token.
    let doc: ZbsCredentialDocument | null = null;
    for (;;) {
      const now = new Date();
      doc = await this.credentialModel
        .findOneAndUpdate(
          {
            key: ZBS_CREDENTIAL_KEY,
            $or: [{ refreshLockUntil: { $exists: false } }, { refreshLockUntil: null }, { refreshLockUntil: { $lt: now } }],
          },
          { $set: { refreshLockOwner: this.ownerId, refreshLockUntil: new Date(now.getTime() + leaseMs) } },
          { new: true },
        )
        .exec();
      if (doc) break;
      if (Date.now() > deadline) {
        return fail('RETRYABLE', 'REFRESH_LOCK_TIMEOUT', 'Một tiến trình khác đang làm mới token — thử lại sau');
      }
      await sleep(LOCK_POLL_MS);
      const other = await this.credentialModel.findOne({ key: ZBS_CREDENTIAL_KEY }).exec();
      if (!other) return fail('AUTHENTICATION_REQUIRED', 'NO_CREDENTIALS', 'Chưa có token OA');
      if (other.status === ZbsCredentialStatus.REAUTH_REQUIRED) {
        return fail('AUTHENTICATION_REQUIRED', other.lastRefreshErrorCode ?? 'REAUTH_REQUIRED', 'Refresh token bị từ chối — cần ủy quyền lại OA');
      }
      if (other.accessTokenEnc && isAccessTokenFresh(other) && this.isNewToken(other, opts.rejectedFingerprint)) {
        return { ok: true, accessToken: this.decrypt(other.accessTokenEnc) };
      }
    }

    try {
      // 2. Someone may have refreshed between our read and taking the lock.
      if (doc.status === ZbsCredentialStatus.REAUTH_REQUIRED) {
        return fail('AUTHENTICATION_REQUIRED', doc.lastRefreshErrorCode ?? 'REAUTH_REQUIRED', 'Refresh token bị từ chối — cần ủy quyền lại OA');
      }
      if (doc.accessTokenEnc && isAccessTokenFresh(doc) && (!opts.force || (opts.rejectedFingerprint && this.isNewToken(doc, opts.rejectedFingerprint)))) {
        return { ok: true, accessToken: this.decrypt(doc.accessTokenEnc) };
      }
      if (!doc.refreshTokenEnc) return fail('AUTHENTICATION_REQUIRED', 'NO_REFRESH_TOKEN', 'Chưa có refresh token');

      // 3. Spend the single-use refresh token.
      const res = await this.client.refreshAccessToken(this.decrypt(doc.refreshTokenEnc));
      if (res.ok) {
        await this.persistTokens(res.data, 'REFRESH');
        this.logger.log('ZBS: đã làm mới access token (refresh token đã xoay vòng)');
        return { ok: true, accessToken: res.data.accessToken };
      }

      if (res.errorClass === 'AUTHENTICATION_REQUIRED') {
        await this.credentialModel
          .updateOne(
            { key: ZBS_CREDENTIAL_KEY },
            {
              $set: {
                status: ZbsCredentialStatus.REAUTH_REQUIRED,
                lastRefreshErrorCode: res.errorCode,
                lastRefreshErrorMessage: res.description.slice(0, 300),
              },
            },
          )
          .exec();
        this.logger.error(`ZBS: refresh token bị từ chối (${res.errorCode}) — cần ủy quyền lại OA`);
        return fail('AUTHENTICATION_REQUIRED', res.errorCode, res.description);
      }

      // Network / 5xx / unknown: nothing was sent to a customer, so the job may retry later.
      // (If an UNKNOWN refresh did consume the token, the next attempt is rejected → REAUTH.)
      await this.credentialModel
        .updateOne(
          { key: ZBS_CREDENTIAL_KEY },
          { $set: { lastRefreshErrorCode: res.errorCode, lastRefreshErrorMessage: res.description.slice(0, 300) } },
        )
        .exec();
      this.logger.warn(`ZBS: làm mới token thất bại tạm thời (${res.errorCode}, ${res.errorClass})`);
      return fail('RETRYABLE', `REFRESH_${res.errorCode}`, res.description);
    } finally {
      await this.credentialModel
        .updateOne(
          { key: ZBS_CREDENTIAL_KEY, refreshLockOwner: this.ownerId },
          { $unset: { refreshLockOwner: 1, refreshLockUntil: 1 } },
        )
        .exec()
        .catch(() => undefined);
    }
  }

  private isNewToken(doc: ZbsCredentialDocument, rejectedFingerprint?: string): boolean {
    if (!rejectedFingerprint || !doc.accessTokenEnc) return true;
    return tokenFingerprint(this.decrypt(doc.accessTokenEnc)) !== rejectedFingerprint;
  }

  /** Unconditional write: Zalo has already invalidated the previous refresh token. */
  private async persistTokens(tokens: ZbsOAuthTokens, source: 'REFRESH' | 'OAUTH_CODE'): Promise<void> {
    const key = this.encryptionKey();
    const now = new Date();
    const cfg = this.configService.get();
    await this.credentialModel
      .updateOne(
        { key: ZBS_CREDENTIAL_KEY },
        {
          $set: {
            status: ZbsCredentialStatus.ACTIVE,
            source,
            accessTokenEnc: encryptToken(tokens.accessToken, key),
            accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
            refreshTokenEnc: encryptToken(tokens.refreshToken, key),
            refreshTokenObtainedAt: now,
            lastRefreshAt: now,
            // The current ENV seed (if any) is now superseded — don't re-seed from it.
            ...(cfg.seedRefreshToken ? { envSeedFingerprint: this.envSeedFingerprint() } : {}),
          },
          $unset: { lastRefreshErrorCode: 1, lastRefreshErrorMessage: 1 },
        },
        { upsert: true },
      )
      .exec();
  }

  private encryptionKey(): Buffer {
    const key = this.configService.encryptionKey();
    if (!key) throw new Error('ZALO_ZBS_TOKEN_ENCRYPTION_KEY chưa hợp lệ');
    return key;
  }

  private decrypt(enc: string): string {
    try {
      return decryptToken(enc, this.encryptionKey());
    } catch {
      throw new TokenDecryptError();
    }
  }

  private internalFailure(err: unknown): ZbsAuthResult {
    if (err instanceof TokenDecryptError) {
      return fail(
        'CONFIGURATION_REQUIRED',
        'TOKEN_DECRYPT_FAILED',
        'Không giải mã được token đã lưu — ZALO_ZBS_TOKEN_ENCRYPTION_KEY đã đổi? Cần nạp lại token (ENV mới hoặc exchange-code)',
      );
    }
    this.logger.error(`ZBS auth lỗi nội bộ: ${(err as Error)?.message}`);
    return fail('RETRYABLE', 'AUTH_INTERNAL_ERROR', (err as Error)?.message ?? 'Lỗi nội bộ');
  }
}

class TokenDecryptError extends Error {}

function isAccessTokenFresh(doc: { accessTokenExpiresAt?: Date | null }): boolean {
  // An ENV-seeded token has no known expiry: use it until Zalo answers -124.
  if (!doc.accessTokenExpiresAt) return true;
  return new Date(doc.accessTokenExpiresAt).getTime() - EXPIRY_SKEW_MS > Date.now();
}

function fail(errorClass: ZbsErrorClass, errorCode: string, description: string): ZbsAuthResult {
  return { ok: false, errorClass, errorCode, description };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
