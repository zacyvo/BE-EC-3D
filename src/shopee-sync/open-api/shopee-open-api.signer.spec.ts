import { createHmac } from 'crypto';
import { buildAuthPartnerUrl, signPublic, signShop } from './shopee-open-api.signer';
import { classifyShopeeError } from './shopee-open-api.client';

const KEY = 'test-partner-key-0001';

describe('Shopee Open API signing', () => {
  it('public sign = HMAC-SHA256(partner_key, partner_id + path + timestamp), lowercase hex', () => {
    const expected = createHmac('sha256', KEY).update('2001234/api/v2/auth/token/get1700000000').digest('hex');
    expect(signPublic(2001234, '/api/v2/auth/token/get', 1700000000, KEY)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shop sign appends access_token + shop_id', () => {
    const expected = createHmac('sha256', KEY).update('2001234/api/v2/product/get_item_list1700000000tok-abc76624421').digest('hex');
    expect(signShop(2001234, '/api/v2/product/get_item_list', 1700000000, 'tok-abc', 76624421, KEY)).toBe(expected);
  });

  it('auth_partner URL is signed over the auth path and keeps our state inside `redirect`', () => {
    const url = new URL(
      buildAuthPartnerUrl({
        host: 'https://partner.shopeemobile.com',
        partnerId: 2001234,
        partnerKey: KEY,
        redirectUrl: 'https://api.example.vn/api/v1/integrations/shopee/open-api/callback?state=s1',
        timestamp: 1700000000,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://partner.shopeemobile.com/api/v2/shop/auth_partner');
    expect(url.searchParams.get('sign')).toBe(signPublic(2001234, '/api/v2/shop/auth_partner', 1700000000, KEY));
    expect(url.searchParams.get('redirect')).toBe('https://api.example.vn/api/v1/integrations/shopee/open-api/callback?state=s1');
    expect(url.toString()).not.toContain(KEY);
  });
});

describe('classifyShopeeError', () => {
  const ITEM_LIST = '/api/v2/product/get_item_list';
  it.each([
    ['error_auth', 'Invalid access_token.', 403, ITEM_LIST, 'AUTH'],
    ['invalid_acceess_token', 'Invalid access_token', 200, ITEM_LIST, 'AUTH'],
    ['error_too_many_request', 'too many', 429, ITEM_LIST, 'RATE_LIMITED'],
    ['', '', 503, ITEM_LIST, 'RETRYABLE'],
    ['error_server', 'busy', 200, ITEM_LIST, 'RETRYABLE'],
    ['error_param', 'item_id_list invalid', 200, ITEM_LIST, 'PERMANENT'],
    ['error_permission', 'no permission', 200, ITEM_LIST, 'PERMANENT'],
    ['error_param', 'Invalid refresh_token', 200, '/api/v2/auth/access_token/get', 'REAUTH'],
    ['error_auth', 'code expired', 403, '/api/v2/auth/token/get', 'REAUTH'],
    ['', '', 502, '/api/v2/auth/access_token/get', 'RETRYABLE'],
  ])('%s / %s / HTTP %s on %s → %s', (error, message, status, path, expected) => {
    expect(classifyShopeeError(error, message, status, path)).toBe(expected);
  });
});
