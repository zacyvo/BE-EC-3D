import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { hostname } from 'os';
import {
  ShopeeOpenApiCredential,
  ShopeeOpenApiCredentialDocument,
  ShopeeOpenApiCredentialStatus,
} from '../schemas/shopee-open-api-credential.schema';
import { ShopeeOpenApiAuthState, ShopeeOpenApiAuthStateDocument } from '../schemas/shopee-open-api-auth-state.schema';
import { AuditService } from '../../audit/audit.service';
import { decryptToken, encryptToken, tokenFingerprint } from '../../zalo-zbs/zbs-token-crypto';
import { ShopeeSyncConfigService } from '../shopee-sync.config';
import { ShopeeSyncErrorCode, SHOPEE_SYNC_AUDIT_MODULE } from '../shopee-sync.constants';
import { ShopeeSyncException } from '../shopee-sync.exceptions';
import { ShopeeOpenApiConfigService } from './shopee-open-api.config';
import { ShopeeCallResult, ShopeeErrorClass, ShopeeOpenApiClient } from './shopee-open-api.client';
import { buildAuthPartnerUrl, nowSeconds } from './shopee-open-api.signer';
import type { ShopeeShopInfo, ShopeeTokenResponse } from './shopee-open-api.types';

export const SHOPEE_CREDENTIAL_KEY = 'default';

const STATE_TTL_MS = 15 * 60 * 1000;
/** Refresh this long before the access token's expiry (access token ≈ 4h). */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_S = 4 * 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_LEASE_MS = 45_000;
const LOCK_POLL_MS = 300;

export type ShopeeAuthResult =
  | { ok: true; accessToken: string; shopId: number }
  | { ok: false; errorClass: ShopeeErrorClass | 'NOT_CONNECTED' | 'CONFIG'; errorCode: string; message: string };

export interface ShopeeOpenApiStatusView {
  configured: boolean;
  configErrors: string[];
  connected: boolean;
  status: ShopeeOpenApiCredentialStatus | 'NONE';
  shopeeShopId?: string;
  shopName?: string;
  region?: string;
  authorizedAt?: Date;
  authorizationExpiresAt?: Date;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  lastRefreshAt?: Date;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastOrderSyncAt?: Date;
  orderAutoSyncMinutes: number;
  host: string;
}

/**
 * Shop authorization + token lifecycle for Shopee Open Platform v2:
 *  1. SUPER_ADMIN clicks "Kết nối Shopee" → createAuthUrl(): signed auth_partner URL whose
 *     redirect carries a one-time `state`.
 *  2. Seller logs in on Shopee, approves → Shopee redirects to SHOPEE_REDIRECT_URL with
 *     `code` + `shop_id` → handleCallback() exchanges the code (token/get), stores tokens.
 *  3. Every API call goes through getAccessToken(): refreshes (access_token/get) when the
 *     4h access token is about to expire. The refresh token rotates → the new pair is
 *     persisted immediately, under a DB lease so only one process ever spends it.
 */
@Injectable()
export class ShopeeOpenApiAuthService {
  private readonly logger = new Logger(ShopeeOpenApiAuthService.name);
  readonly ownerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

  constructor(
    @InjectModel(ShopeeOpenApiCredential.name) private readonly credentialModel: Model<ShopeeOpenApiCredentialDocument>,
    @InjectModel(ShopeeOpenApiAuthState.name) private readonly stateModel: Model<ShopeeOpenApiAuthStateDocument>,
    private readonly configService: ShopeeOpenApiConfigService,
    private readonly syncConfigService: ShopeeSyncConfigService,
    private readonly client: ShopeeOpenApiClient,
    private readonly auditService: AuditService,
  ) {}

  // ─── Authorization (connect / disconnect) ──────────────────────────────────

  async createAuthUrl(staffId: string): Promise<{ url: string; expiresAt: Date }> {
    this.assertConfigured();
    const cfg = this.configService.get();
    const state = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await this.stateModel.create({ stateHash: sha256(state), staffId: new Types.ObjectId(staffId), expiresAt });

    const redirect = new URL(cfg.redirectUrl);
    redirect.searchParams.set('state', state);
    const url = buildAuthPartnerUrl({
      host: cfg.host,
      partnerId: cfg.partnerId,
      partnerKey: cfg.partnerKey,
      redirectUrl: redirect.toString(),
      timestamp: nowSeconds(),
    });
    return { url, expiresAt };
  }

  /** Never throws — always returns where to send the browser (Admin page + result flag). */
  async handleCallback(query: { code?: unknown; shop_id?: unknown; state?: unknown }): Promise<{ redirectUrl: string }> {
    const back = (result: 'success' | 'error', message?: string) => {
      const url = new URL(this.configService.get().adminReturnUrl);
      url.searchParams.set('shopee_auth', result);
      if (message) url.searchParams.set('message', message.slice(0, 200));
      return { redirectUrl: url.toString() };
    };

    try {
      const code = typeof query.code === 'string' ? query.code.trim() : '';
      const state = typeof query.state === 'string' ? query.state.trim() : '';
      const shopIdRaw = typeof query.shop_id === 'string' ? query.shop_id.trim() : '';
      if (!code || !state) return back('error', 'Thiếu code/state từ Shopee — vui lòng thử kết nối lại');
      if (!/^\d+$/.test(shopIdRaw)) {
        return back('error', 'Shopee không trả về shop_id — hãy uỷ quyền bằng tài khoản Shop (không phải Merchant/Main account)');
      }

      // Single-use: consume atomically so a replayed callback URL can't re-run the exchange.
      const stateDoc = await this.stateModel
        .findOneAndUpdate({ stateHash: sha256(state), usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } })
        .exec();
      if (!stateDoc) return back('error', 'Phiên kết nối đã hết hạn hoặc không hợp lệ — vui lòng bấm "Kết nối Shopee" lại');

      const expectedShopId = this.syncConfigService.get().publicShopId;
      if (expectedShopId && expectedShopId !== shopIdRaw) {
        return back(
          'error',
          `Shop vừa uỷ quyền (${shopIdRaw}) khác shop đã cấu hình SHOPEE_SYNC_PUBLIC_SHOP_ID (${expectedShopId}) — đăng nhập đúng shop rồi thử lại`,
        );
      }

      const shopId = Number(shopIdRaw);
      const res = await this.client.getTokenByCode(code, shopId);
      if (!res.ok) return back('error', `Shopee từ chối đổi token: ${res.errorCode} — ${res.message}`);
      if (!res.data.access_token || !res.data.refresh_token) return back('error', 'Shopee trả về thiếu access_token/refresh_token');

      await this.persistTokens(res.data, {
        shopeeShopId: shopIdRaw,
        authorizedBy: stateDoc.staffId,
        authorizedAt: new Date(),
      });
      await this.refreshShopInfo(res.data.access_token, shopId);

      await this.auditService.log({
        actorId: stateDoc.staffId.toString(),
        actorType: 'staff',
        action: 'shopee_open_api.connect',
        module: SHOPEE_SYNC_AUDIT_MODULE,
        targetId: shopIdRaw,
      });
      this.logger.log(`Shopee Open API: đã kết nối shop ${shopIdRaw}`);
      return back('success');
    } catch (err) {
      this.logger.error(`Shopee Open API callback lỗi: ${(err as Error)?.message}`);
      return back('error', 'Lỗi nội bộ khi lưu kết nối Shopee — xem log backend');
    }
  }

  /** Forget the tokens locally. (Revoking on Shopee's side is done by the seller in
   * Seller Center → or via the cancel_auth_partner URL; not needed to stop syncing.) */
  async disconnect(staffId: string): Promise<{ disconnected: boolean }> {
    const res = await this.credentialModel.deleteOne({ key: SHOPEE_CREDENTIAL_KEY }).exec();
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'shopee_open_api.disconnect',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: SHOPEE_CREDENTIAL_KEY,
    });
    return { disconnected: res.deletedCount > 0 };
  }

  async statusView(): Promise<ShopeeOpenApiStatusView> {
    const cfg = this.configService.get();
    const configErrors = this.configService.configErrors();
    const doc = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).lean().exec();
    return {
      configured: configErrors.length === 0,
      configErrors,
      connected: !!doc?.refreshTokenEnc && doc.status === ShopeeOpenApiCredentialStatus.ACTIVE,
      status: doc?.status ?? 'NONE',
      shopeeShopId: doc?.shopeeShopId,
      shopName: doc?.shopName,
      region: doc?.region,
      authorizedAt: doc?.authorizedAt,
      authorizationExpiresAt: doc?.authorizationExpiresAt,
      accessTokenExpiresAt: doc?.accessTokenExpiresAt,
      refreshTokenExpiresAt: doc?.refreshTokenExpiresAt,
      lastRefreshAt: doc?.lastRefreshAt,
      lastErrorCode: doc?.lastErrorCode,
      lastErrorMessage: doc?.lastErrorMessage,
      lastOrderSyncAt: doc?.lastOrderSyncAt,
      orderAutoSyncMinutes: cfg.orderAutoSyncMinutes,
      host: cfg.host,
    };
  }

  /** Throws a user-facing exception unless a shop is connected and usable. */
  async requireConnected(): Promise<ShopeeOpenApiCredentialDocument> {
    this.assertConfigured();
    const doc = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).exec();
    if (!doc?.refreshTokenEnc) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_OPEN_API_NOT_CONNECTED,
        'Chưa kết nối Shopee Open API — Super Admin cần bấm "Kết nối Shopee" trước',
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    if (doc.status === ShopeeOpenApiCredentialStatus.REAUTH_REQUIRED) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_OPEN_API_REAUTH_REQUIRED,
        'Uỷ quyền Shopee đã hết hạn hoặc bị thu hồi — Super Admin cần kết nối lại',
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    return doc;
  }

  // ─── Access token ──────────────────────────────────────────────────────────

  /** A usable access token, refreshing first when (about to be) expired. Never throws. */
  async getAccessToken(): Promise<ShopeeAuthResult> {
    try {
      if (this.configService.configErrors().length) {
        return { ok: false, errorClass: 'CONFIG', errorCode: 'CONFIG_INVALID', message: this.configService.configErrors().join('; ') };
      }
      const doc = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).exec();
      const notReady = this.notReady(doc);
      if (notReady) return notReady;
      if (doc!.accessTokenEnc && isFresh(doc!)) {
        return { ok: true, accessToken: this.decrypt(doc!.accessTokenEnc), shopId: Number(doc!.shopeeShopId) };
      }
      return this.refresh();
    } catch (err) {
      this.logger.error(`Shopee auth lỗi nội bộ: ${(err as Error)?.message}`);
      return { ok: false, errorClass: 'RETRYABLE', errorCode: 'AUTH_INTERNAL_ERROR', message: (err as Error)?.message ?? 'Lỗi nội bộ' };
    }
  }

  /** After Shopee rejected `usedToken`: refresh unless another worker already replaced it. */
  async handleRejectedAccessToken(usedToken: string): Promise<ShopeeAuthResult> {
    try {
      const doc = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).exec();
      const notReady = this.notReady(doc);
      if (notReady) return notReady;
      if (doc!.accessTokenEnc) {
        const current = this.decrypt(doc!.accessTokenEnc);
        if (tokenFingerprint(current) !== tokenFingerprint(usedToken) && isFresh(doc!)) {
          return { ok: true, accessToken: current, shopId: Number(doc!.shopeeShopId) };
        }
      }
      return this.refresh(tokenFingerprint(usedToken));
    } catch (err) {
      return { ok: false, errorClass: 'RETRYABLE', errorCode: 'AUTH_INTERNAL_ERROR', message: (err as Error)?.message ?? 'Lỗi nội bộ' };
    }
  }

  /** Called by the API layer when Shopee says the shop authorization itself is gone. */
  async markReauthRequired(errorCode: string, message: string): Promise<void> {
    await this.credentialModel
      .updateOne(
        { key: SHOPEE_CREDENTIAL_KEY },
        { $set: { status: ShopeeOpenApiCredentialStatus.REAUTH_REQUIRED, lastErrorCode: errorCode, lastErrorMessage: message.slice(0, 300) } },
      )
      .exec();
  }

  // ─── Order-sync lease (shared by manual + scheduled runs, multi-instance safe) ─

  async acquireOrderSyncLock(leaseMs: number): Promise<boolean> {
    const now = new Date();
    const doc = await this.credentialModel
      .findOneAndUpdate(
        {
          key: SHOPEE_CREDENTIAL_KEY,
          $or: [{ orderSyncLockUntil: { $exists: false } }, { orderSyncLockUntil: null }, { orderSyncLockUntil: { $lt: now } }],
        },
        { $set: { orderSyncLockOwner: this.ownerId, orderSyncLockUntil: new Date(now.getTime() + leaseMs) } },
      )
      .exec();
    return !!doc;
  }

  async extendOrderSyncLock(leaseMs: number): Promise<void> {
    await this.credentialModel
      .updateOne({ key: SHOPEE_CREDENTIAL_KEY, orderSyncLockOwner: this.ownerId }, { $set: { orderSyncLockUntil: new Date(Date.now() + leaseMs) } })
      .exec();
  }

  async releaseOrderSyncLock(completed: boolean): Promise<void> {
    await this.credentialModel
      .updateOne(
        { key: SHOPEE_CREDENTIAL_KEY, orderSyncLockOwner: this.ownerId },
        { $unset: { orderSyncLockOwner: 1, orderSyncLockUntil: 1 }, ...(completed ? { $set: { lastOrderSyncAt: new Date() } } : {}) },
      )
      .exec()
      .catch(() => undefined);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertConfigured(): void {
    const errors = this.configService.configErrors();
    if (errors.length) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SHOPEE_OPEN_API_NOT_CONFIGURED,
        `Chưa cấu hình Shopee Open API: ${errors.join('; ')}`,
        HttpStatus.PRECONDITION_FAILED,
      );
    }
  }

  private notReady(doc: ShopeeOpenApiCredentialDocument | null): ShopeeAuthResult | null {
    if (!doc?.refreshTokenEnc) {
      return { ok: false, errorClass: 'NOT_CONNECTED', errorCode: 'NOT_CONNECTED', message: 'Chưa kết nối Shopee Open API' };
    }
    if (doc.status === ShopeeOpenApiCredentialStatus.REAUTH_REQUIRED) {
      return {
        ok: false,
        errorClass: 'REAUTH',
        errorCode: doc.lastErrorCode ?? 'REAUTH_REQUIRED',
        message: 'Uỷ quyền Shopee đã hết hạn/bị thu hồi — cần kết nối lại',
      };
    }
    return null;
  }

  private async refresh(rejectedFingerprint?: string): Promise<ShopeeAuthResult> {
    const deadline = Date.now() + REFRESH_LEASE_MS + 5_000;

    // 1. Take the refresh lease — or wait for whoever holds it and reuse their new token.
    let doc: ShopeeOpenApiCredentialDocument | null = null;
    for (;;) {
      const now = new Date();
      doc = await this.credentialModel
        .findOneAndUpdate(
          {
            key: SHOPEE_CREDENTIAL_KEY,
            $or: [{ refreshLockUntil: { $exists: false } }, { refreshLockUntil: null }, { refreshLockUntil: { $lt: now } }],
          },
          { $set: { refreshLockOwner: this.ownerId, refreshLockUntil: new Date(now.getTime() + REFRESH_LEASE_MS) } },
          { new: true },
        )
        .exec();
      if (doc) break;
      if (Date.now() > deadline) {
        return { ok: false, errorClass: 'RETRYABLE', errorCode: 'REFRESH_LOCK_TIMEOUT', message: 'Tiến trình khác đang làm mới token Shopee' };
      }
      await sleep(LOCK_POLL_MS);
      const other = await this.credentialModel.findOne({ key: SHOPEE_CREDENTIAL_KEY }).exec();
      const notReady = this.notReady(other);
      if (notReady) return notReady;
      if (other!.accessTokenEnc && isFresh(other!) && this.isNewToken(other!, rejectedFingerprint)) {
        return { ok: true, accessToken: this.decrypt(other!.accessTokenEnc), shopId: Number(other!.shopeeShopId) };
      }
    }

    try {
      const notReady = this.notReady(doc);
      if (notReady) return notReady;
      // 2. Someone may have refreshed between our read and taking the lease.
      if (doc.accessTokenEnc && isFresh(doc) && this.isNewToken(doc, rejectedFingerprint)) {
        return { ok: true, accessToken: this.decrypt(doc.accessTokenEnc), shopId: Number(doc.shopeeShopId) };
      }

      // 3. Spend the rotating refresh token.
      const shopId = Number(doc.shopeeShopId);
      const res: ShopeeCallResult<ShopeeTokenResponse> = await this.client.refreshAccessToken(this.decrypt(doc.refreshTokenEnc!), shopId);
      if (res.ok && res.data.access_token && res.data.refresh_token) {
        await this.persistTokens(res.data, { shopeeShopId: doc.shopeeShopId });
        this.logger.log('Shopee Open API: đã làm mới access token');
        return { ok: true, accessToken: res.data.access_token, shopId };
      }

      const errorCode = res.ok ? 'MALFORMED_TOKEN_RESPONSE' : res.errorCode;
      const message = res.ok ? 'Shopee trả về thiếu token khi refresh' : res.message;
      if (!res.ok && res.errorClass === 'REAUTH') {
        await this.markReauthRequired(errorCode, message);
        this.logger.error(`Shopee Open API: refresh token bị từ chối (${errorCode}) — cần kết nối lại`);
        return { ok: false, errorClass: 'REAUTH', errorCode, message };
      }
      await this.credentialModel
        .updateOne({ key: SHOPEE_CREDENTIAL_KEY }, { $set: { lastErrorCode: errorCode, lastErrorMessage: message.slice(0, 300) } })
        .exec();
      return { ok: false, errorClass: 'RETRYABLE', errorCode: `REFRESH_${errorCode}`, message };
    } finally {
      await this.credentialModel
        .updateOne({ key: SHOPEE_CREDENTIAL_KEY, refreshLockOwner: this.ownerId }, { $unset: { refreshLockOwner: 1, refreshLockUntil: 1 } })
        .exec()
        .catch(() => undefined);
    }
  }

  /** Unconditional write: Shopee has already rotated the refresh token. */
  private async persistTokens(
    tokens: ShopeeTokenResponse,
    extra: { shopeeShopId: string; authorizedBy?: Types.ObjectId; authorizedAt?: Date },
  ): Promise<void> {
    const key = this.encryptionKey();
    const now = Date.now();
    const expiresIn = tokens.expire_in && tokens.expire_in > 0 ? tokens.expire_in : DEFAULT_ACCESS_TOKEN_TTL_S;
    await this.credentialModel
      .updateOne(
        { key: SHOPEE_CREDENTIAL_KEY },
        {
          $set: {
            status: ShopeeOpenApiCredentialStatus.ACTIVE,
            accessTokenEnc: encryptToken(tokens.access_token!, key),
            accessTokenExpiresAt: new Date(now + expiresIn * 1000),
            refreshTokenEnc: encryptToken(tokens.refresh_token!, key),
            refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
            lastRefreshAt: new Date(now),
            ...extra,
          },
          $unset: { lastErrorCode: 1, lastErrorMessage: 1 },
        },
        { upsert: true },
      )
      .exec();
  }

  /** Best-effort: shop name + authorization expiry for the Admin card. */
  private async refreshShopInfo(accessToken: string, shopId: number): Promise<void> {
    const res = await this.client.callShop<ShopeeShopInfo>('GET', '/api/v2/shop/get_shop_info', { accessToken, shopId });
    if (!res.ok) return;
    await this.credentialModel
      .updateOne(
        { key: SHOPEE_CREDENTIAL_KEY },
        {
          $set: {
            ...(res.data.shop_name ? { shopName: res.data.shop_name } : {}),
            ...(res.data.region ? { region: res.data.region } : {}),
            ...(res.data.expire_time ? { authorizationExpiresAt: new Date(res.data.expire_time * 1000) } : {}),
          },
        },
      )
      .exec();
  }

  private isNewToken(doc: ShopeeOpenApiCredentialDocument, rejectedFingerprint?: string): boolean {
    if (!rejectedFingerprint || !doc.accessTokenEnc) return true;
    return tokenFingerprint(this.decrypt(doc.accessTokenEnc)) !== rejectedFingerprint;
  }

  private encryptionKey(): Buffer {
    const key = this.configService.encryptionKey();
    if (!key) throw new Error('SHOPEE_TOKEN_ENCRYPTION_KEY chưa hợp lệ');
    return key;
  }

  private decrypt(enc: string): string {
    try {
      return decryptToken(enc, this.encryptionKey());
    } catch {
      throw new Error('Không giải mã được token Shopee — SHOPEE_TOKEN_ENCRYPTION_KEY đã đổi? Cần kết nối lại');
    }
  }
}

function isFresh(doc: { accessTokenExpiresAt?: Date | null }): boolean {
  return !!doc.accessTokenExpiresAt && new Date(doc.accessTokenExpiresAt).getTime() - EXPIRY_SKEW_MS > Date.now();
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
