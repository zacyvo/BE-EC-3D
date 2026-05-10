import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomOrdersService } from './custom-orders.service';
import { CustomOrdersController, AdminCustomOrdersController } from './custom-orders.controller';
import { CustomOrder, CustomOrderSchema } from './schemas/custom-order.schema';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomOrder.name, schema: CustomOrderSchema },
    ]),
    AuditModule,
  ],
  controllers: [CustomOrdersController, AdminCustomOrdersController],
  providers: [CustomOrdersService],
})
export class CustomOrdersModule {}
