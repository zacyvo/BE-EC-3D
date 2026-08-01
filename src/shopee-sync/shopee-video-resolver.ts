/**
 * Single, backend-side authority for turning Shopee's raw `video_list[].video_id`
 * into a storable, playable URL. Unlike images, the extension never sends a
 * client-guessed URL for video at all — only the raw id — so there is no "trust
 * the client's URL if it's already on an allowed host" fallback here: the URL is
 * ALWAYS deterministically rebuilt from `SHOPEE_VIDEO_URL_TEMPLATE`, which by
 * construction can only ever point at the one configured host (OWASP: no
 * SSRF/stored-arbitrary-URL vector via this field).
 *
 * `video_id` is a CDN *path* (e.g. `api/v4/11110107/mms/xxx.mp4`), not a bare id —
 * its `/` separators must stay literal, so (unlike the image template) this does
 * NOT `encodeURIComponent` the value.
 */
export function buildShopeeVideoUrl(videoId: string, template: string): string {
  return template.replace('{video_id}', videoId);
}

/** `null` when Shopee has no video (or a blank video_id) for this product. */
export function resolveShopeeVideoUrl(videoId: string | null | undefined, template: string): string | null {
  if (!videoId || videoId.trim().length === 0) return null;
  return buildShopeeVideoUrl(videoId, template);
}
