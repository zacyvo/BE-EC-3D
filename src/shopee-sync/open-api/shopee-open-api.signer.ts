import { createHmac } from 'crypto';

/**
 * Shopee Open Platform v2 request signing (developer guide "Authorization and Authentication"):
 *   sign = hex(HMAC-SHA256(partner_key, base_string)), lowercase
 *   Public APIs (auth_partner, token/get, access_token/get): base = partner_id + api_path + timestamp
 *   Shop APIs:                                              base = partner_id + api_path + timestamp + access_token + shop_id
 * `api_path` is the path only (e.g. `/api/v2/product/get_item_list`), never the host or query.
 * `timestamp` is unix SECONDS and Shopee rejects it after 5 minutes.
 */
export function signPublic(partnerId: number, apiPath: string, timestamp: number, partnerKey: string): string {
  return hmac(partnerKey, `${partnerId}${apiPath}${timestamp}`);
}

export function signShop(
  partnerId: number,
  apiPath: string,
  timestamp: number,
  accessToken: string,
  shopId: number,
  partnerKey: string,
): string {
  return hmac(partnerKey, `${partnerId}${apiPath}${timestamp}${accessToken}${shopId}`);
}

export const AUTH_PARTNER_PATH = '/api/v2/shop/auth_partner';

/** The URL the seller opens to authorize this app for their shop. Shopee appends
 * `code` + `shop_id` to `redirectUrl` (keeping its own query string, e.g. our `state`). */
export function buildAuthPartnerUrl(opts: {
  host: string;
  partnerId: number;
  partnerKey: string;
  redirectUrl: string;
  timestamp: number;
}): string {
  const sign = signPublic(opts.partnerId, AUTH_PARTNER_PATH, opts.timestamp, opts.partnerKey);
  const qs = new URLSearchParams({
    partner_id: String(opts.partnerId),
    timestamp: String(opts.timestamp),
    sign,
    redirect: opts.redirectUrl,
  });
  return `${opts.host}${AUTH_PARTNER_PATH}?${qs.toString()}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hmac(key: string, base: string): string {
  return createHmac('sha256', key).update(base).digest('hex');
}
