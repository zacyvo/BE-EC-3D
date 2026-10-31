import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';
import { ZaloBotModule } from '../zalo-bot/zalo-bot.module';
import { OrderReturnsService } from './order-returns.service';
import { AdminOrderReturnsController, OrderReturnsController } from './order-returns.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: OrderVersion.name, schema: OrderVersionSchema },
    ]),
    AuditModule,
    UsersModule,
    ZaloBotModule,
  ],
  controllers: [OrderReturnsController, AdminOrderReturnsController],
  providers: [OrderReturnsService],
})
export class OrderReturnsModule {}
