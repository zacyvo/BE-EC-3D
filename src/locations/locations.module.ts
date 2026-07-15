import { Module } from '@nestjs/common';
import { AddressConversionService } from './address-conversion.service';
import { LocationsController } from './locations.controller';

@Module({
  controllers: [LocationsController],
  providers: [AddressConversionService],
  exports: [AddressConversionService],
})
export class LocationsModule {}
