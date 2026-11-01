/** Flat shipping fee until a carrier integration (GHN/GHTK…) quotes real rates.
 * Keep in sync with frontend-user/src/lib/shipping-fee.ts and frontend-admin/src/lib/shipping-fee.ts. */
export const SHIPPING_FEE_HCM = 22_000;
export const SHIPPING_FEE_OTHER = 27_000;

/** True for TP. Hồ Chí Minh in any common spelling ("Hồ Chí Minh", "TP. HCM", "Thành phố Hồ Chí Minh",
 * "Sài Gòn"…). Uses the post-2025-merger boundary: the address picker and old-address conversion
 * both store the new province, so former Bình Dương / Bà Rịa - Vũng Tàu addresses count as HCM. */
export function isHoChiMinhCity(city?: string | null): boolean {
  const normalized = (city ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return /hochiminh|hcm|saigon/.test(normalized);
}

export function computeShippingFee(city?: string | null): number {
  return isHoChiMinhCity(city) ? SHIPPING_FEE_HCM : SHIPPING_FEE_OTHER;
}
