import { BadRequestException, Injectable } from '@nestjs/common';
import * as conversionData from '../data/vn-address-conversion.json';

export interface ConversionEntry {
  oldProvince: string;
  oldDistrict: string;
  oldWard: string | null;
  districtCode: number;
  wardCode: number | null;
  newProvinceCode: number;
  newProvince: string;
  newWardCode: number;
  newWard: string;
}

/**
 * Authoritative old-address (pre-2025-merger) -> new-address crosswalk.
 * Data built from the public-domain vietnamadminunits dataset (63 old
 * provinces/districts/wards -> 34 new provinces/wards). Never trust a
 * client-submitted new address alongside an old one -- always resolve()
 * and use the returned entry.
 */
@Injectable()
export class AddressConversionService {
  private readonly byWardCode = new Map<number, ConversionEntry>();
  private readonly byDistrictCode = new Map<number, ConversionEntry>();

  constructor() {
    const data = conversionData as unknown as {
      byWardCode: Record<string, ConversionEntry>;
      byDistrictCode: Record<string, ConversionEntry>;
    };
    for (const [code, entry] of Object.entries(data.byWardCode)) {
      this.byWardCode.set(Number(code), entry);
    }
    for (const [code, entry] of Object.entries(data.byDistrictCode)) {
      this.byDistrictCode.set(Number(code), entry);
    }
  }

  /** Resolves an old district/ward selection to its canonical old + new address.
   * Throws 400 when the codes don't resolve to any known entry. */
  resolve(districtCode: number, wardCode?: number): ConversionEntry {
    if (wardCode !== undefined) {
      const byWard = this.byWardCode.get(wardCode);
      if (byWard) return byWard;
    }
    const byDistrict = this.byDistrictCode.get(districtCode);
    if (byDistrict) return byDistrict;
    throw new BadRequestException(
      'Không tìm thấy dữ liệu chuyển đổi cho địa chỉ cũ này',
    );
  }
}
