/**
 * Single, backend-side authority for turning a Shopee image reference into a
 * storable `sourceUrl` — mirrors (but does not trust) the extension's own
 * `normalizers/image-normalizer.ts`. The backend NEVER persists a client-supplied
 * URL verbatim unless it already points at Shopee's own CDN host; otherwise it is
 * deterministically rebuilt from `SHOPEE_IMAGE_URL_TEMPLATE` + the image id, so a
 * malicious/buggy extension payload can never get an arbitrary URL stored (OWASP:
 * no stored-XSS/SSRF vector via this field, no `javascript:`/`data:`/other host).
 */
const ALLOWED_IMAGE_HOST_SUFFIX = 'img.susercontent.com';

export function isAllowedShopeeImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === ALLOWED_IMAGE_HOST_SUFFIX || h.endsWith(`.${ALLOWED_IMAGE_HOST_SUFFIX}`);
}

export function buildShopeeImageUrlFromTemplate(imageId: string, template: string): string {
  return template.replace('{image_id}', encodeURIComponent(imageId));
}

/**
 * Returns a URL that is safe to store: the client's URL if (and only if) it is a
 * well-formed `https://…img.susercontent.com/…` URL, otherwise a freshly-built one
 * from the configured template.
 */
export function resolveShopeeImageUrl(
  sourceImageId: string,
  clientSourceUrl: string,
  imageUrlTemplate: string,
): string {
  try {
    const parsed = new URL(clientSourceUrl);
    if (parsed.protocol === 'https:' && isAllowedShopeeImageHost(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    // not a valid absolute URL at all — fall through to rebuilding from the template
  }
  return buildShopeeImageUrlFromTemplate(sourceImageId, imageUrlTemplate);
}
