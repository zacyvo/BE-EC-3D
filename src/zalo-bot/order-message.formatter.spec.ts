import {
  buildAdminOrderUrl,
  describePaymentStatus,
  formatOrderCreatedMessage,
  formatVnd,
  maskPhone,
} from './order-message.formatter';

const baseOrder = {
  _id: '66f1a2b3c4d5e6f7a8b9c0d1',
  createdAt: new Date('2026-10-17T07:05:00Z'),
  status: 'PENDING',
  items: [
    { productName: 'Khung ảnh 3D', quantity: 2, subtotal: 180000 },
    { productName: 'Móc khóa 3D', quantity: 1, subtotal: 79000, color: 'Trắng', size: 'M' },
  ],
  shippingInfo: { recipientName: 'Nguyễn Văn A', phone: '0912345689' },
  subtotal: 259000,
  discountAmount: 0,
  shippingFee: 0,
  total: 259000,
  paidAmount: 0,
};

describe('order message formatter', () => {
  it('TEST 12: formats money with vi-VN grouping', () => {
    expect(formatVnd(259000)).toBe('259.000đ');
    expect(formatVnd(1234567)).toBe('1.234.567đ');
    expect(formatVnd(0)).toBe('0đ');
    expect(formatVnd(undefined)).toBe('0đ');
  });

  it('masks phone numbers by default (first/last 2 digits)', () => {
    expect(maskPhone('0912345689')).toBe('09******89');
    expect(maskPhone('+84912345689')).toBe('84*******89');
    expect(maskPhone('')).toBe('(không có)');
  });

  it('renders the real order fields', () => {
    const text = formatOrderCreatedMessage(baseOrder, { adminUrl: 'https://admin.luxe-glow.vn' });
    expect(text).toContain('🔔 LUXE GLOW — ĐƠN HÀNG MỚI');
    expect(text).toContain('Mã đơn: #A8B9C0D1');
    expect(text).toContain('Khách hàng: Nguyễn Văn A');
    expect(text).toContain('SĐT: 09******89');
    expect(text).not.toContain('0912345689');
    expect(text).toContain('- Khung ảnh 3D x 2 — 180.000đ');
    expect(text).toContain('- Móc khóa 3D (Trắng, M) x 1 — 79.000đ');
    expect(text).toContain('Tổng tiền: 259.000đ');
    expect(text).toContain('Thanh toán: COD (thanh toán khi nhận hàng)');
    expect(text).toContain('Trạng thái đơn: Chờ xác nhận');
    expect(text).toContain('https://admin.luxe-glow.vn/orders?search=66f1a2b3c4d5e6f7a8b9c0d1');
    expect(text).toContain('17/10/2026');
  });

  it('shows discount and shipping fee lines only when non-zero', () => {
    const text = formatOrderCreatedMessage({ ...baseOrder, subtotal: 300000, discountAmount: 41000, total: 259000 });
    expect(text).toContain('Tạm tính: 300.000đ');
    expect(text).toContain('Giảm giá: -41.000đ');
    expect(text).not.toContain('Phí vận chuyển');
  });

  it('TEST 13: many products → stays ≤ 2000 chars and reports the remainder', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      productName: `Đèn ngủ in 3D phiên bản đặc biệt số ${i + 1} — ${'x'.repeat(60)}`,
      quantity: i + 1,
      subtotal: 150000 * (i + 1),
    }));
    const text = formatOrderCreatedMessage({ ...baseOrder, items }, { adminUrl: 'https://admin.luxe-glow.vn' });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/… và \d+ sản phẩm khác/);
    expect(text).toContain('Tổng tiền:');
    expect(text).toContain('https://admin.luxe-glow.vn/orders?search=');
  });

  it('every item fits when the order is small (no "… và" line)', () => {
    expect(formatOrderCreatedMessage(baseOrder)).not.toContain('sản phẩm khác');
  });

  it('TEST 14: missing optional customer data → no runtime error', () => {
    const text = formatOrderCreatedMessage({ _id: '66f1a2b3c4d5e6f7a8b9c0d1' });
    expect(text).toContain('Khách hàng: (không có)');
    expect(text).toContain('SĐT: (không có)');
    expect(text).toContain('Tổng tiền: 0đ');
    expect(text).not.toContain('Xem đơn hàng'); // no adminUrl → no link
    expect(() => formatOrderCreatedMessage({})).not.toThrow();
  });

  it('TEST 22: pending online payment is never described as paid', () => {
    const text = formatOrderCreatedMessage({ ...baseOrder, paymentMethod: 'BANK_TRANSFER', paidAmount: 0 });
    expect(text).toContain('Thanh toán: Chuyển khoản');
    expect(text).toContain('Trạng thái thanh toán: Chưa thanh toán');
    expect(text).not.toMatch(/Đã thanh toán/);
  });

  it('describes partial / full payment from paidAmount only', () => {
    expect(describePaymentStatus(259000, 0)).toBe('Chưa thanh toán');
    expect(describePaymentStatus(259000, 100000)).toBe('Đã thanh toán 100.000đ — còn lại 159.000đ');
    expect(describePaymentStatus(259000, 259000)).toBe('Đã thanh toán đủ');
    expect(describePaymentStatus(0, 0)).toBe('Chưa thanh toán');
  });

  it('builds the admin link from the real orders route (no tokens in URL)', () => {
    expect(buildAdminOrderUrl('https://admin.luxe-glow.vn/', 'abc')).toBe('https://admin.luxe-glow.vn/orders?search=abc');
    expect(buildAdminOrderUrl('', 'abc')).toBeNull();
  });
});
