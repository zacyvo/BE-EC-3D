import { maskZbsPhone, normalizeVnPhone } from './zbs-phone';

describe('normalizeVnPhone (TEST 06/07/08)', () => {
  it.each([
    ['0987654321', '84987654321'],
    ['84987654321', '84987654321'],
    ['+84987654321', '84987654321'],
    ['0084987654321', '84987654321'],
    ['098 765 4321', '84987654321'],
    ['098.765.4321', '84987654321'],
    ['(+84) 98-765-4321', '84987654321'],
    ['+84 0987654321', '84987654321'],
    ['0321234567', '84321234567'],
    ['0561234567', '84561234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeVnPhone(input)).toEqual({ ok: true, phone: expected });
  });

  it.each([
    [undefined, 'MISSING'],
    ['', 'MISSING'],
    ['   ', 'MISSING'],
    ['(+84)******321', 'MASKED'],
    ['09876xxxxx', 'MASKED'],
    ['abc0987654321', 'MALFORMED'],
    ['098765432', 'MALFORMED'], // 9 digits
    ['09876543210', 'MALFORMED'], // 11 digits starting with 0
    ['987654321', 'MALFORMED'], // no trunk/country code — never guessed
    ['+1 650 555 0100', 'UNSUPPORTED_PREFIX'],
    ['0287654321', 'UNSUPPORTED_PREFIX'], // landline (028) — not a mobile prefix
    ['0127654321', 'UNSUPPORTED_PREFIX'], // retired 11-digit-era prefix
  ])('%s → rejected (%s)', (input, reason) => {
    expect(normalizeVnPhone(input as string)).toEqual({ ok: false, reason });
  });

  it('never invents or substitutes a number', () => {
    const r = normalizeVnPhone(null);
    expect(r.ok).toBe(false);
  });
});

describe('maskZbsPhone (TEST 28)', () => {
  it('keeps only prefix and last 2 digits', () => {
    expect(maskZbsPhone('84987654321')).toBe('849******21');
    expect(maskZbsPhone('84987654321')).not.toContain('765');
    expect(maskZbsPhone('')).toBe('—');
  });
});
