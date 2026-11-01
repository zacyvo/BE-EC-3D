import { computeShippingFee, isHoChiMinhCity, SHIPPING_FEE_HCM, SHIPPING_FEE_OTHER } from './shipping-fee.util';

describe('shipping-fee.util', () => {
  it.each(['Hồ Chí Minh', 'TP. Hồ Chí Minh', 'Thành phố Hồ Chí Minh', 'TP.HCM', 'tp hcm', 'Sài Gòn', 'Ho Chi Minh City'])(
    '%s → HCM',
    (city) => {
      expect(isHoChiMinhCity(city)).toBe(true);
      expect(computeShippingFee(city)).toBe(SHIPPING_FEE_HCM);
    },
  );

  it.each(['Hà Nội', 'Đồng Nai', 'Tây Ninh', 'Cần Thơ', '', undefined, null])('%s → other provinces', (city) => {
    expect(isHoChiMinhCity(city)).toBe(false);
    expect(computeShippingFee(city)).toBe(SHIPPING_FEE_OTHER);
  });

  it('fees are 22K (HCM) and 27K (elsewhere)', () => {
    expect(SHIPPING_FEE_HCM).toBe(22000);
    expect(SHIPPING_FEE_OTHER).toBe(27000);
  });
});
