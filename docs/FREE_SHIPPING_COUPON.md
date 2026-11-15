# Free-shipping coupons & checkout coupon input

## What it does
- New coupon type `free_shipping` (alongside `percentage` / `fixed`). It waives the order's shipping fee —
  the whole fee, or up to `maxDiscountAmount` when that is > 0. `value` is unused (stored as 0).
- Storefront checkout always shows a **Mã giảm giá** card: a free-text input (any code, e.g. `FREE_SHIP`)
  plus chips for the customer's assigned codes. Each selected code shows "applied (−amount)" or the reason
  it was rejected. Codes are re-validated automatically when the address (province) changes.
- Admin → Khuyến mãi: coupon form has type **Miễn phí vận chuyển** with "Giảm phí ship tối đa (0 = toàn bộ)",
  and every coupon can now be edited (pencil icon) — code itself is read-only.

## Rules (PromotionsService.validateCoupons)
- Goods coupons (`order` kind) stack in order; floor rule: goods total after them must stay ≥ 50.000đ.
- Shipping coupons (`shipping` kind): at most one per order; need a known shipping fee — from the server-side
  fee (`opts.shippingFee`) at order creation, or `city` in `POST /promotions/validate` (server computes the
  fee with `computeShippingFee`). The floor rule ignores shipping.
- `POST /promotions/validate` response adds `rejectedCoupons[{code, reason}]`, `shippingDiscount`,
  `shippingFee` (null = no address yet). `appliedCoupons[].kind` is `order` | `shipping`.

## Order fields
- `Order.shippingFee` is the fee **charged** (already net of the code), so `total = subtotal − discountAmount
  + shippingFee` and every downstream consumer (VietQR amount, e-invoice shipping line, Zalo messages,
  returns) stays unchanged.
- `Order.shippingDiscount` = waived amount (display only). Original fee = `shippingFee + shippingDiscount`.

## Default FREE_SHIP code
- On boot `PromotionsService.onModuleInit → ensureDefaultFreeShipCoupon()` seeds a program
  "Miễn phí vận chuyển" (`systemKey: DEFAULT_FREE_SHIP`, all customers, ends 2099) with code `FREE_SHIP`
  (whole fee, 1 use per customer, no min order). It is created **inactive** — turn on "Kích hoạt" in admin.
- Seeds once per DB: skipped if the systemKey program exists (even after edits) or any program already
  has a `FREE_SHIP` code. Unique sparse index on `systemKey` guards concurrent boots.
- The system program cannot be deleted (API returns 400) — switch it off instead.

Tests: `src/promotions/free-shipping-coupon.integration.spec.ts`.
