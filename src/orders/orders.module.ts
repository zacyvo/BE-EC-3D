import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { OrdersService } from './orders.service';
import { OrdersController, AdminOrdersController } from './orders.controller';
import { OrderAdjustmentsController, AdminOrderAdjustmentsController } from './order-adjustments.controller';
import { OrderAdjustmentService } from './order-adjustment.service';
import { OrderPublicAccessService } from './order-public-access.service';
import { PublicOrderAccessController, AdminOrderAccessController, GuestCheckoutController } from './order-public-access.controller';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrderVersion, OrderVersionSchema } from './schemas/order-version.schema';
import { ProductsModule } from '../products/products.module';
import { CartModule } from '../cart/cart.module';
import { AuditModule } from '../audit/audit.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { UsersModule } from '../users/users.module';
import { LocationsModule } from '../locations/locations.module';
import { ZaloBotModule } from '../zalo-bot/zalo-bot.module';
import { PaymentsModule } from '../payments/payments.module';
import { StaffModule } from '../staff/staff.module';

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
    ZaloBotModule,
    PaymentsModule,
    StaffModule,
    JwtModule.register({}),
  ],
  // Public controllers first: their literal 'orders/public/...' / 'orders/guest-checkout' routes must win over 'orders/:id/...'.
  controllers: [
    GuestCheckoutController,
    PublicOrderAccessController,
    AdminOrderAccessController,
    OrdersController, AdminOrdersController, OrderAdjustmentsController, AdminOrderAdjustmentsController,
  ],
  providers: [OrdersService, OrderAdjustmentService, OrderPublicAccessService],
  exports: [OrdersService, OrderAdjustmentService, OrderPublicAccessService],
})
export class OrdersModule {}
