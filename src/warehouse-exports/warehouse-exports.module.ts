import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WarehouseExportsController } from './warehouse-exports.controller';
import { WarehouseExportsService } from './warehouse-exports.service';
import {
  WarehouseExport,
  WarehouseExportSchema,
} from './schemas/warehouse-export.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WarehouseExport.name, schema: WarehouseExportSchema },
    ]),
  ],
  controllers: [WarehouseExportsController],
  providers: [WarehouseExportsService],
})
export class WarehouseExportsModule {}
