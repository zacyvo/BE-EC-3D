import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AddressConversionService } from './address-conversion.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly addressConversionService: AddressConversionService) {}

  /** Preview the new address that a given old district/ward resolves to. */
  @Get('old-address/resolve')
  resolveOldAddress(
    @Query('districtCode') districtCodeRaw: string,
    @Query('wardCode') wardCodeRaw?: string,
  ) {
    const districtCode = Number(districtCodeRaw);
    if (!districtCodeRaw || Number.isNaN(districtCode)) {
      throw new BadRequestException('districtCode không hợp lệ');
    }
    let wardCode: number | undefined;
    if (wardCodeRaw !== undefined && wardCodeRaw !== '') {
      wardCode = Number(wardCodeRaw);
      if (Number.isNaN(wardCode)) throw new BadRequestException('wardCode không hợp lệ');
    }

    const entry = this.addressConversionService.resolve(districtCode, wardCode);
    return {
      old: {
        province: entry.oldProvince,
        district: entry.oldDistrict,
        ward: entry.oldWard,
        districtCode: entry.districtCode,
        wardCode: entry.wardCode,
      },
      new: {
        provinceCode: entry.newProvinceCode,
        province: entry.newProvince,
        wardCode: entry.newWardCode,
        ward: entry.newWard,
      },
    };
  }
}
