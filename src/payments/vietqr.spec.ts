import {
  buildVietQrPayload,
  crc16Ccitt,
  decodeVietQrPayload,
  parseTlv,
  VietQrError,
} from './vietqr';

/**
 * Independent vectors: each expected payload was produced by a different implementation,
 * `vietnam-qr-pay@1.5.1` (MIT, github.com/xuannghia/vietnam-qr-pay), with
 * `QRPay.initVietQR({ bankBin, bankNumber, amount, purpose }).build()`, and decoded back by the same
 * library (isValid, NAPAS GUID, BIN, account, amount, purpose all matched) — run once outside the
 * project on 2026-11-01; the library is not a project dependency.
 */
const INDEPENDENT_VECTORS = [
  {
    input: { bankBin: '970436', accountNumber: '0011001932418', amount: 150000, description: 'LG6A1B2C3D' },
    payload:
      '00020101021238570010A00000072701270006970436011300110019324180208QRIBFTTA530370454061500005802VN62140810LG6A1B2C3D63045D2A',
  },
  {
    input: { bankBin: '970422', accountNumber: '0123456789', amount: 1, description: 'LG00000001' },
    payload:
      '00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA5303704540115802VN62140810LG000000016304CFCE',
  },
  {
    input: { bankBin: '970415', accountNumber: '113366668888', amount: 259000, description: 'LGABCDEF12' },
    payload:
      '00020101021238560010A0000007270126000697041501121133666688880208QRIBFTTA530370454062590005802VN62140810LGABCDEF1263040F15',
  },
  {
    input: { bankBin: '970418', accountNumber: '8888', amount: 9999999999, description: 'Thanh toan don LG12345678' },
    payload:
      '00020101021238480010A00000072701180006970418010488880208QRIBFTTA5303704541099999999995802VN62290825Thanh toan don LG123456786304529A',
  },
];

describe('VietQR payload', () => {
  it('CRC16-CCITT-FALSE matches the standard check value', () => {
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });

  it.each(INDEPENDENT_VECTORS)('matches an independent implementation byte for byte ($input.description)', ({ input, payload }) => {
    expect(buildVietQrPayload(input)).toBe(payload);
  });

  it('encodes bank BIN, account, amount, reference, VND and VN', () => {
    const payload = buildVietQrPayload({ bankBin: '970436', accountNumber: '0011001932418', amount: 150000, description: 'LG6A1B2C3D' });
    const root = parseTlv(payload);
    expect(root['00']).toBe('01');
    expect(root['01']).toBe('12'); // dynamic: amount is fixed
    expect(root['53']).toBe('704');
    expect(root['54']).toBe('150000');
    expect(root['58']).toBe('VN');
    const merchant = parseTlv(root['38']);
    expect(merchant['00']).toBe('A000000727');
    expect(merchant['02']).toBe('QRIBFTTA');
    expect(parseTlv(merchant['01'])).toEqual({ '00': '970436', '01': '0011001932418' });
    expect(parseTlv(root['62'])).toEqual({ '08': 'LG6A1B2C3D' });

    expect(decodeVietQrPayload(payload)).toEqual({
      bankBin: '970436',
      accountNumber: '0011001932418',
      amount: 150000,
      description: 'LG6A1B2C3D',
      currency: '704',
      country: 'VN',
      serviceCode: 'QRIBFTTA',
    });
  });

  it('keeps leading zeros of the account number', () => {
    const decoded = decodeVietQrPayload(
      buildVietQrPayload({ bankBin: '970422', accountNumber: '000123', amount: 5000, description: 'LG00000002' }),
    );
    expect(decoded.accountNumber).toBe('000123');
  });

  it('is deterministic and different orders get different payloads', () => {
    const a = { bankBin: '970436', accountNumber: '123', amount: 150000, description: 'LGAAAAAAAA' };
    expect(buildVietQrPayload(a)).toBe(buildVietQrPayload({ ...a }));
    expect(buildVietQrPayload(a)).not.toBe(buildVietQrPayload({ ...a, description: 'LGBBBBBBBB' }));
  });

  it.each([0, -1, 1.5, Number.NaN, 10_000_000_000_000])('rejects invalid amount %p', (amount) => {
    expect(() => buildVietQrPayload({ bankBin: '970436', accountNumber: '123', amount, description: 'LG1' })).toThrow(VietQrError);
  });

  it.each([
    ['BIN', { bankBin: '97043', accountNumber: '123', description: 'LG1' }],
    ['account', { bankBin: '970436', accountNumber: '12-34', description: 'LG1' }],
    ['account length', { bankBin: '970436', accountNumber: '1'.repeat(20), description: 'LG1' }],
    ['accented description', { bankBin: '970436', accountNumber: '123', description: 'Đơn LG1' }],
    ['long description', { bankBin: '970436', accountNumber: '123', description: 'X'.repeat(26) }],
  ])('rejects invalid %s', (_label, fields) => {
    expect(() => buildVietQrPayload({ amount: 1000, ...fields })).toThrow(VietQrError);
  });

  it('decode rejects a tampered payload (CRC)', () => {
    const payload = INDEPENDENT_VECTORS[0].payload;
    const tampered = payload.replace('5406150000', '5406950000');
    expect(() => decodeVietQrPayload(tampered)).toThrow('Sai CRC');
  });
});
