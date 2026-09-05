import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FilamentsService } from './filaments.service';
import { FilamentsController } from './filaments.controller';
import {
  FilamentImport, FilamentImportSchema,
  FilamentUnit, FilamentUnitSchema,
} from './schemas/filament.schema';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FilamentImport.name, schema: FilamentImportSchema },
      { name: FilamentUnit.name, schema: FilamentUnitSchema },
    ]),
    InvoicesModule,
  ],
  controllers: [FilamentsController],
  providers: [FilamentsService],
  exports: [FilamentsService],
})
export class FilamentsModule {}
