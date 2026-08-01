import { buildShopeeVideoUrl, resolveShopeeVideoUrl } from './shopee-video-resolver';

const TEMPLATE = 'https://cvf.shopee.vn/file/{video_id}';

describe('buildShopeeVideoUrl', () => {
  it('substitutes the raw video_id path as-is, keeping "/" separators literal', () => {
    const videoId = 'api/v4/11110107/mms/vn-11110107-6va08-mr1ciuzjh7nwd2.16000081784879360.mp4';
    expect(buildShopeeVideoUrl(videoId, TEMPLATE)).toBe(`https://cvf.shopee.vn/file/${videoId}`);
  });
});

describe('resolveShopeeVideoUrl', () => {
  it('builds the full URL from a videoId', () => {
    expect(resolveShopeeVideoUrl('api/v4/1/mms/x.mp4', TEMPLATE)).toBe('https://cvf.shopee.vn/file/api/v4/1/mms/x.mp4');
  });

  it('returns null when videoId is null', () => {
    expect(resolveShopeeVideoUrl(null, TEMPLATE)).toBeNull();
  });

  it('returns null when videoId is undefined', () => {
    expect(resolveShopeeVideoUrl(undefined, TEMPLATE)).toBeNull();
  });

  it('returns null when videoId is blank', () => {
    expect(resolveShopeeVideoUrl('   ', TEMPLATE)).toBeNull();
  });
});
