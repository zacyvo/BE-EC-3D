import { parseInfoCommand, parsePaymentCommand } from './payment-command.parser';

describe('parsePaymentCommand', () => {
  it.each([
    'Đơn hàng: LG6A1B2C3D\nĐã thanh toán',
    'Don hang: LG6A1B2C3D\nDa thanh toan',
    'don hang: lg6a1b2c3d\nda thanh toan',
    'ĐƠN HÀNG: LG6A1B2C3D\nĐÃ THANH TOÁN',
    '  Đơn  hàng :  LG6A1B2C3D  \r\n\n  Đã   thanh toán.  ',
    'Đơn hàng LG6A1B2C3D Đã thanh toán',
    'Đơn hàng: LG6A1B2C3D, đã thanh toán',
    'Đơn hàng - #LG6A1B2C3D\nĐã thanh toán!',
    // Decomposed (NFD) accents, as some keyboards send them.
    'Đơn hàng: LG6A1B2C3D\nĐã thanh toán'.normalize('NFD'),
  ])('accepts %p', (text) => {
    expect(parsePaymentCommand(text)).toEqual({
      kind: 'CONFIRM_PAYMENT',
      orderRef: { kind: 'REFERENCE', value: 'LG6A1B2C3D' },
    });
  });

  it('accepts the admin display code and the full order id', () => {
    expect(parsePaymentCommand('Đơn hàng: #6A1B2C3D\nĐã thanh toán')).toEqual({
      kind: 'CONFIRM_PAYMENT',
      orderRef: { kind: 'DISPLAY_CODE', value: '6A1B2C3D' },
    });
    expect(parsePaymentCommand('Đơn hàng: 65f0c1a2b3c4d5e6f7a8b9c0\nĐã thanh toán')).toEqual({
      kind: 'CONFIRM_PAYMENT',
      orderRef: { kind: 'OBJECT_ID', value: '65F0C1A2B3C4D5E6F7A8B9C0' },
    });
  });

  it.each(['Xin chào', 'Cảm ơn shop', 'đã thanh toán rồi nhé', '', '   ', 'LG6A1B2C3D'])('ignores unrelated %p', (text) => {
    expect(parsePaymentCommand(text)).toEqual({ kind: 'NOT_COMMAND' });
  });

  it('ignores non-string input', () => {
    expect(parsePaymentCommand(undefined)).toEqual({ kind: 'NOT_COMMAND' });
    expect(parsePaymentCommand(null)).toEqual({ kind: 'NOT_COMMAND' });
  });

  it.each([
    'Đơn hàng: LG6A1B2C3D, LG11112222\nĐã thanh toán',
    'Đơn hàng: LG6A1B2C3D\nĐơn hàng: LG11112222\nĐã thanh toán',
    'Đơn hàng: LG6A1B2C3D LG11112222 Đã thanh toán',
  ])('rejects multiple orders %p', (text) => {
    expect(parsePaymentCommand(text)).toEqual({ kind: 'INVALID', reason: 'MULTIPLE_ORDERS' });
  });

  it.each([
    'Đơn hàng: LG6A1B2C3D\nChưa thanh toán',
    'Đơn hàng: LG6A1B2C3D\nĐã thanh toán một nửa',
    'Đơn hàng: LG6A1B2C3D',
    'Đơn hàng: LG6A1B2C3D\nĐã hủy',
    'Đơn hàng: LG6A1B2C3D\nĐã thanh toán\nGiao gấp nhé',
    `Đơn hàng: LG6A1B2C3D\nĐã thanh toán${' '.repeat(300)}x`,
  ])('rejects malformed command %p', (text) => {
    expect(parsePaymentCommand(text)).toEqual({ kind: 'INVALID', reason: 'BAD_FORMAT' });
  });

  it.each(['Đơn hàng: ABC\nĐã thanh toán', 'Đơn hàng: LG10268\nĐã thanh toán', 'Đơn hàng: 6A1B2C3\nĐã thanh toán'])(
    'rejects an order code that is not in the project format %p',
    (text) => {
      expect(parsePaymentCommand(text)).toEqual({ kind: 'INVALID', reason: 'BAD_ORDER_CODE' });
    },
  );
});

describe('parseInfoCommand', () => {
  it.each([
    'Danh sách', 'danh sach', 'DS', 'ds', '/ds', '/list', 'Danh sách đơn chờ xác nhận thanh toán',
    'Đơn chờ thanh toán', 'chờ xác nhận', 'Danh sách chờ thanh toán.',
  ])('recognizes the pending list %p', (text) => {
    expect(parseInfoCommand(text)).toBe('LIST_PENDING');
  });

  it.each(['Hướng dẫn', 'help', '/help', '/start', 'Lệnh', 'menu', '?'])('recognizes help %p', (text) => {
    expect(parseInfoCommand(text)).toBe('HELP');
  });

  it.each(['Xin chào', 'danh sách sản phẩm', 'Đơn hàng: LG6A1B2C3D\nĐã thanh toán', '', 'x'.repeat(150)])(
    'ignores %p',
    (text) => {
      expect(parseInfoCommand(text)).toBeNull();
    },
  );
});
