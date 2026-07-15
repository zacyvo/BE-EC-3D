import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersService } from './orders.service';
import { OrdersController, AdminOrdersController } from './orders.controller';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrderVersion, OrderVersionSchema } from './schemas/order-version.schema';
import { ProductsModule } from '../products/products.module';
import { CartModule } from '../cart/cart.module';
import { AuditModule } from '../audit/audit.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { UsersModule } from '../users/users.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: OrderVersion.name, schema: OrderVersionSchema },
    ]),
    ProductsModule,
    CartModule,
    AuditModule,
    PromotionsModule,
    UsersModule,
    LocationsModule,
  ],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
