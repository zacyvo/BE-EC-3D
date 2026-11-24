# Promotion conditions ("Điều kiện áp dụng") & program presets

## What it does
A promotion program can now restrict **who / what / when** its codes apply, on top of the existing
"Đối tượng" (all customers / assigned customers), date range and per-code limits. Every rule is optional;
the ones switched on must **all** hold (AND). Codes can also bundle free shipping, and a program can be
marked "không dùng chung mã khác". Admin → Khuyến mãi has 20 ready-made presets that fill the form.

## Data (Promotion schema)
`Promotion.conditions` (embedded `PromotionConditions`, only the rules that are on are stored):

| Field | Rule | Customer-facing rejection (example) |
|---|---|---|
| `newAccountWithinDays` | account `createdAt` within N days ("lần đầu đăng ký tài khoản") | Mã chỉ dành cho tài khoản mới đăng ký trong 30 ngày |
| `firstOrderOnly` | no previous order except CANCELLED | Mã chỉ áp dụng cho đơn hàng đầu tiên của bạn |
| `minCompletedOrders` / `maxCompletedOrders` | count of DELIVERED orders in range | … từ 2 đơn hàng thành công (bạn đang có 1) |
| `minTotalSpent` | Σ total of DELIVERED orders − `returnRequest.refundAmount` of settled returns (REFUNDING/COMPLETED) | … tổng chi tiêu từ 1.000.000₫ (bạn đang có 900.000₫) |
| `birthdayMonthOnly` | `User.dob` month = current month (VN time) | Mã sinh nhật: vui lòng cập nhật ngày sinh trong Hồ sơ |
| `inactiveDays` | has ≥ 1 DELIVERED order, latest non-cancelled order ≥ N days ago | Mã dành cho khách quay lại sau 60 ngày chưa mua hàng |
| `marketingOptInOnly` | `User.marketingOptIn` | … bật trong Hồ sơ của bạn |
| `minItemQuantity` | Σ quantity of the cart | Mua tối thiểu 3 sản phẩm để dùng mã này (đang có 2) |
| `productIds` / `categoryIds` | scope: discount only on matching lines (product OR category); ≥ 1 such line | Giỏ hàng chưa có sản phẩm thuộc chương trình của mã này |
| `region` | `HCM` / `OUTSIDE_HCM` of the delivery city (same detection as the shipping fee) | Mã chỉ áp dụng cho đơn giao ngoài TP. Hồ Chí Minh |
| `paymentMethods` | `COD` / `BANK_TRANSFER` | Mã chỉ áp dụng khi thanh toán chuyển khoản |
| `weekdays` | 0 = CN … 6 = T7, Vietnam time | Mã chỉ áp dụng vào Thứ 7, Chủ nhật |
| `hourFrom` / `hourTo` | daily window `[from, to)`, VN time, wraps midnight when from > to | Mã chỉ áp dụng trong khung giờ 20:00–22:00 |

Other fields:
- `Promotion.exclusive` — the program's code is never combined with another code (whichever is applied
  first wins; the other is rejected with a reason).
- `CouponItem.includeFreeShipping` + `freeShippingMaxAmount` (0 = whole fee) — a percentage/fixed code that
  **also** waives shipping ("giảm giá kèm free ship"). It is the order's one shipping code. When it can't
  waive shipping (no address yet / another shipping code applied first) the goods part still applies.

Admin validation (`normalizeConditions`): off rules (0/false/[]) are dropped; max < min completed orders,
`firstOrderOnly` with min orders / total spent / win-back, and a half-set hour window are rejected (400).
A PATCH with `conditions` replaces the whole object. All 7 weekdays / both payment methods = no restriction.

## Where it is enforced
`PromotionsService.validateCoupons` — per code, after usage limits: time → order (region, payment, item
count) → customer (profile + order aggregate, loaded once and only when a rule needs it) → product scope
→ min order. Same function at `POST /promotions/validate` (checkout preview) and at order creation
(`OrdersService.create` passes the real items, city and payment method), so the preview can't be gamed.

- `POST /promotions/validate` accepts `items[{productId, quantity, subtotal}]` and `paymentMethod`
  (storefront sends both; re-validates when cart or payment method changes).
- A bundled code returns two `appliedCoupons` entries with the same code (`kind: 'order'` + `'shipping'`);
  `markUsed` dedupes, the storefront shows one row and sends the code once.
- `GET /promotions/my-coupons` hides programs whose **customer** rules the user fails, and adds
  `conditionTexts` (e.g. `["Áp dụng cho: Đèn ngủ", "Thứ 6, Thứ 7", "Không dùng chung mã khác"]`),
  `includeFreeShipping`, `freeShippingMaxAmount`.

Guests still can't use codes (unchanged — see GUEST_CHECKOUT.md).

## Admin UI (frontend-admin)
- `lib/promotionPresets.ts` — 20 presets in 4 groups (Khách hàng / Đơn hàng / Thời gian / Vận chuyển):
  chào mừng thành viên mới, đơn đầu tiên, VIP, thành viên Bạc, mua lần 2, khách thường xuyên, sinh nhật,
  khách quay lại, đăng ký nhận tin, mua nhiều giảm nhiều, đơn lớn, theo danh mục, chuyển khoản, flash sale,
  giờ vàng, cuối tuần, Thứ 6, free ship 500K, free ship TP.HCM, hỗ trợ ship tỉnh. Picking one fills name,
  description, dates, conditions and a suggested code (created right after the program; editable/removable).
- `components/PromotionConditionsEditor.tsx` — the rule editor (create dialog + "Điều kiện áp dụng" section
  of the program detail). Condition chips show in the program list.

## Notes / limits
- Customer history is computed live from `orders` (aggregate on the `userId` index) — fine at the shop's
  size; add a cached per-user summary if order volume grows a lot.
- Birthday codes: `perUserUsageLimit` counts over the whole program period (1 = once per program).
- Orders placed as a guest are on a separate guest user, so they don't count toward a logged-in
  customer's history.

Tests: `src/promotions/promotion-conditions.integration.spec.ts`.
