# Điều chỉnh đơn hàng (Order Adjustment)

Khách đặt sai/thiếu (nhầm màu, thiếu sản phẩm, sai địa chỉ…) nhưng đã chuyển khoản → **Super Admin** sửa đơn,
**khách xác nhận**, rồi phần chênh lệch được hoàn lại hoặc thu thêm.

## Luồng

```
Super Admin "Điều chỉnh đơn hàng"  ──►  adjustment.status = PROPOSED   (đơn CHƯA đổi; email báo khách)
                                         │
              khách "Đồng ý" ◄───────────┼──────────► khách "Từ chối"  → REJECTED (đơn giữ nguyên, Zalo báo chủ shop)
                    │                    └──────────► Super Admin "Thu hồi" / hủy đơn → WITHDRAWN
                    ▼
  ACCEPTED: áp dụng bản mới vào đơn (1 lệnh update có điều kiện) + Zalo báo chủ shop
     chênh lệch = tổng mới − paidAmount (số tiền khách ĐÃ trả, không phải tổng cũ)
       < 0  → REFUND: khách nhập TK nhận tiền → admin chuyển tay → "Xác nhận đã hoàn tiền chênh lệch" (paidAmount −)
       > 0  → EXTRA_PAYMENT: khách chọn
                 • COD  → COD khi tạo đơn giao = tổng − đã trả; tự ghi nhận khi đơn chuyển "Đã giao"
                 • Chuyển khoản → VietQR riêng, nội dung "LG<8 ký tự cuối mã đơn>T<số lần>" (vd LG575FDE88T2)
                   → khách "Tôi đã chuyển khoản" (Zalo báo chủ shop) → admin "Xác nhận đã nhận tiền thêm" (paidAmount +)
       = 0 hoặc đơn chưa thanh toán → không có khoản thanh toán chênh lệch (đơn CK chưa trả: số tiền QR theo tổng mới)
```

## Quy tắc

- Sửa được **mọi hạng mục**: sản phẩm (thêm/xoá/đổi màu-size/số lượng/đơn giá), người nhận + địa chỉ, phí ship, giảm giá, ghi chú.
  Đơn giá mặc định = giá danh mục của phân loại; giữ dòng cũ thì giữ giá cũ (admin sửa được).
- Chỉ đơn **Chờ xác nhận / Đã xác nhận / Đang chuẩn bị hàng**, không phải đơn đồng bộ từ sàn.
- Bị chặn khi: đã xuất HĐĐT (ISSUED), đơn VAT cộng thêm kiểu cũ (`vatAmount > 0`), khách báo CK nhưng chưa xác nhận,
  đang có đề xuất chờ khách, hoặc khoản chênh lệch của lần trước chưa ghi nhận xong.
- Khi đang chờ khách xác nhận: **không chuyển được sang Đang giao/Đã giao**. Hủy đơn → đề xuất tự thu hồi.
- Chống xung đột: đề xuất gắn `expectedVersion`; khách đồng ý chỉ thành công nếu `total` và `paidAmount` chưa đổi kể từ lúc đề xuất.
- Đơn có yêu cầu HĐĐT (PENDING/APPROVED): `einvoiceRequest.vatAmount` tính lại theo đơn mới khi khách đồng ý.
- Không có gì tự chuyển tiền — admin chỉ ghi nhận việc đã chuyển/đã nhận. `paidAmount` luôn = số tiền shop đang giữ.

## Phân quyền

| Thao tác | Vai trò |
|---|---|
| Đề xuất điều chỉnh, thu hồi đề xuất | SUPER_ADMIN |
| Ghi nhận đã hoàn / đã nhận tiền thêm | SUPER_ADMIN, ADMIN |

## API

| Method | Path | Ai |
|---|---|---|
| POST | `/admin/orders/:id/adjustment` | Super Admin — body `ProposeOrderAdjustmentDto` |
| PATCH | `/admin/orders/:id/adjustment/withdraw` | Super Admin |
| PATCH | `/admin/orders/:id/adjustment/settlement/complete` | Super Admin / Admin — `{ transferRef?, note? }` |
| POST | `/orders/:id/adjustment/accept` | Khách — `{ number, refundAccount?, extraPaymentMethod? }` |
| POST | `/orders/:id/adjustment/reject` | Khách — `{ number, reason? }` |
| GET | `/orders/:id/adjustment/payment` | Khách — VietQR phần thêm |
| POST | `/orders/:id/adjustment/payment/report` | Khách — "Tôi đã chuyển khoản" |

## Dữ liệu

`Order.adjustment` (lần mới nhất) + `Order.adjustmentHistory[]` (các lần trước). Mỗi lần lưu `before`/`after`
(ảnh chụp sản phẩm, địa chỉ, tiền), `paidAmountAtProposal`, `balance`, `settlement`. Mỗi bước có OrderVersion + audit log.

## Thông báo

- Khách: email khi có đề xuất (bỏ qua tài khoản khách vãng lai / khi chưa cấu hình `MAIL_USER`). Chưa có Zalo ZBS
  (cần template mới được Zalo duyệt).
- Chủ shop (Zalo Bot): `ORDER_ADJUSTMENT_RESPONDED` (đồng ý/từ chối) và `ADJUSTMENT_PAYMENT_REPORTED`.
  Hai sự kiện này đi qua outbox dạng `<EVENT>#adj<n>` và dedup theo số lần điều chỉnh, nên mỗi lần điều chỉnh đều được báo.

## Code

- `src/orders/order-adjustment.service.ts`, `src/orders/order-adjustments.controller.ts`
- Schema: `src/orders/schemas/order.schema.ts` (`OrderAdjustment…`), hook trong `OrdersService.updateStatus`
- Test: `src/orders/order-adjustment.integration.spec.ts`
- Admin: `frontend-admin/src/components/OrderAdjustmentPanel.tsx`, `OrderAdjustmentEditor.tsx`
- Khách: `frontend-user/src/components/order-adjustment/*`

## Chưa làm / giới hạn

- Zalo Bot chưa có lệnh xác nhận tiền thêm (chỉ trên CMS).
- Tồn kho vẫn không trừ theo đơn (giống checkout) — chỉ kiểm tra đủ hàng khi thêm/tăng số lượng.
- Mã giảm giá đã áp dụng (`appliedCoupons`) giữ nguyên làm lịch sử; tổng giảm giá do admin nhập trực tiếp.
