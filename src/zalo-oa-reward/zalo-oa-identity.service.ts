import { Injectable, Logger } from '@nestjs/common';
import { ZaloOaRewardConfigService, ZaloOaRewardConfigSnapshot } from './zalo-oa-reward.config';
import { appSecretProof, pkceChallenge } from './zalo-oa-crypto';

export type IdentityResult =
  | { ok: true; zaloAppUserId: string }
  | { ok: false; code: string; retryable: boolean };

const ZALO_ID = /^\d{5,32}$/;

/**
 * Turns Zalo credentials into a SERVER-VERIFIED app-scoped Zalo user id. Nothing a browser
 * or Mini App says about "who it is" is trusted — only what Zalo's servers return.
 *
 *  - Zalo Login (Social API, OAuth v4): authorization code + PKCE verifier → POST
 *    oauth.zaloapp.com/v4/access_token (header secret_key) → user access token.
 *  - Mini App: zmp-sdk getAccessToken() → user access token.
 *  - Both: GET graph.zalo.me/v2.0/me?fields=id with headers access_token + appsecret_proof.
 *    appsecret_proof proves the token was issued to OUR Zalo App (a token minted for another
 *    app is rejected), and /me returns the id scoped to that app.
 *
 * Tokens are used once and discarded — never stored, never logged.
 */
@Injectable()
export class ZaloOaIdentityService {
  private readonly logger = new Logger(ZaloOaIdentityService.name);

  constructor(private readonly config: ZaloOaRewardConfigService) {}

  /** oauth.zaloapp.com/v4/permission?app_id&redirect_uri&code_challenge&state (Web). */
  buildPermissionUrl(state: string, codeVerifier: string, cfg: ZaloOaRewardConfigSnapshot = this.config.get()): string {
    const qs = new URLSearchParams({
      app_id: cfg.appId,
      redirect_uri: cfg.oauthRedirectUri,
      code_challenge: pkceChallenge(codeVerifier),
      state,
    });
    return `${cfg.oauthBaseUrl}/v4/permission?${qs.toString()}`;
  }

  async verifyAuthorizationCode(code: string, codeVerifier: string): Promise<IdentityResult> {
    const cfg = this.config.get();
    if (!code || code.length > 2048) return { ok: false, code: 'OAUTH_CODE_INVALID', retryable: false };
    const body = new URLSearchParams({
      code,
      app_id: cfg.appId,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    const res = await this.request(`${cfg.oauthBaseUrl}/v4/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: cfg.appSecret },
      body: body.toString(),
    }, cfg);
    if (!res.ok) return res;
    const accessToken = typeof res.json.access_token === 'string' ? res.json.access_token : '';
    if (!accessToken) {
      const err = res.json.error ?? res.json.error_name ?? 'NO_ACCESS_TOKEN';
      this.logger.warn(`Zalo OAuth: đổi code thất bại (${String(err).slice(0, 40)})`);
      return { ok: false, code: 'OAUTH_EXCHANGE_FAILED', retryable: false };
    }
    return this.verifyUserAccessToken(accessToken);
  }

  async verifyUserAccessToken(accessToken: string): Promise<IdentityResult> {
    const cfg = this.config.get();
    if (!accessToken || accessToken.length > 4096) return { ok: false, code: 'ACCESS_TOKEN_INVALID', retryable: false };
    const res = await this.request(`${cfg.graphBaseUrl}/v2.0/me?fields=id`, {
      method: 'GET',
      headers: { access_token: accessToken, appsecret_proof: appSecretProof(accessToken, cfg.appSecret) },
    }, cfg);
    if (!res.ok) return res;
    const error = Number(res.json.error ?? 0);
    const id = typeof res.json.id === 'string' || typeof res.json.id === 'number' ? String(res.json.id) : '';
    if (error !== 0 || !ZALO_ID.test(id)) {
      this.logger.warn(`Zalo /me từ chối token (error=${Number.isFinite(error) ? error : '?'})`);
      return { ok: false, code: 'IDENTITY_REJECTED', retryable: false };
    }
    return { ok: true, zaloAppUserId: id };
  }

  private async request(
    url: string,
    init: RequestInit,
    cfg: ZaloOaRewardConfigSnapshot,
  ): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; code: string; retryable: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, code: `HTTP_${res.status}_NON_JSON`, retryable: res.status >= 500 };
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, code: 'MALFORMED_RESPONSE', retryable: false };
      }
      if (res.status >= 500) return { ok: false, code: `HTTP_${res.status}`, retryable: true };
      return { ok: true, json: json as Record<string, unknown> };
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      this.logger.warn(`Zalo identity request lỗi mạng (${aborted ? 'timeout' : 'network'})`);
      return { ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK', retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
