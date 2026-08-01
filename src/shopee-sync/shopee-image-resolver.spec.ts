import { buildShopeeImageUrlFromTemplate, isAllowedShopeeImageHost, resolveShopeeImageUrl } from './shopee-image-resolver';

const TEMPLATE = 'https://down-vn.img.susercontent.com/file/{image_id}';

describe('isAllowedShopeeImageHost', () => {
  it('allows the exact host', () => {
    expect(isAllowedShopeeImageHost('img.susercontent.com')).toBe(true);
  });

  it('allows subdomains of the CDN host', () => {
    expect(isAllowedShopeeImageHost('down-vn.img.susercontent.com')).toBe(true);
  });

  it('rejects unrelated hosts', () => {
    expect(isAllowedShopeeImageHost('evil.com')).toBe(false);
    expect(isAllowedShopeeImageHost('img.susercontent.com.evil.com')).toBe(false);
  });
});

describe('buildShopeeImageUrlFromTemplate', () => {
  it('encodes the image id into the template (test #21)', () => {
    expect(buildShopeeImageUrlFromTemplate('vn-11134207-81ztc-moggtdc76t4xc6', TEMPLATE)).toBe(
      'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-moggtdc76t4xc6',
    );
  });

  it('percent-encodes special characters in the id', () => {
    expect(buildShopeeImageUrlFromTemplate('id with space', TEMPLATE)).toBe(
      'https://down-vn.img.susercontent.com/file/id%20with%20space',
    );
  });
});

describe('resolveShopeeImageUrl', () => {
  it('keeps a well-formed URL already on the allowed Shopee CDN host', () => {
    const url = 'https://down-vn.img.susercontent.com/file/abc123';
    expect(resolveShopeeImageUrl('abc123', url, TEMPLATE)).toBe(url);
  });

  it('rebuilds from the template when the client URL is on a disallowed host', () => {
    expect(resolveShopeeImageUrl('abc123', 'https://evil.com/abc123', TEMPLATE)).toBe(
      'https://down-vn.img.susercontent.com/file/abc123',
    );
  });

  it('rebuilds from the template when the client value is not a URL at all (e.g. a bare image id)', () => {
    expect(resolveShopeeImageUrl('abc123', 'abc123', TEMPLATE)).toBe('https://down-vn.img.susercontent.com/file/abc123');
  });

  it('never accepts a javascript: URL', () => {
    expect(resolveShopeeImageUrl('abc123', 'javascript:alert(1)', TEMPLATE)).toBe(
      'https://down-vn.img.susercontent.com/file/abc123',
    );
  });

  it('never accepts a data: URL', () => {
    expect(resolveShopeeImageUrl('abc123', 'data:text/html,<script>alert(1)</script>', TEMPLATE)).toBe(
      'https://down-vn.img.susercontent.com/file/abc123',
    );
  });
});
