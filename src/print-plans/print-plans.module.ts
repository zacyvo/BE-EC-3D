import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PrintPlansService } from './print-plans.service';
import { PrintPlansController } from './print-plans.controller';
import { PrintPlan, PrintPlanSchema } from './schemas/print-plan.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PrintPlan.name, schema: PrintPlanSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    AuditModule,
  ],
  controllers: [PrintPlansController],
  providers: [PrintPlansService],
})
export class PrintPlansModule {}
