import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionSchema } from '../orders/schemas/order-version.schema';
import { AuditModule } from '../audit/audit.module';
import { PaymentEvent, PaymentEventSchema } from './schemas/payment-event.schema';
import { BankTransferConfigService } from './bank-transfer.config';
import { BankTransferService } from './bank-transfer.service';
import { PaymentConfirmationService } from './payment-confirmation.service';
import { PaymentsController } from './payments.controller';

/** VietQR bank transfer + manual payment confirmation (docs/VIETQR_PAYMENT.md). Depends on no
 * other feature module, so OrdersModule (customer/CMS endpoints) and ZaloBotModule (admin bot
 * command) can both import it without a cycle. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: OrderVersion.name, schema: OrderVersionSchema },
      { name: PaymentEvent.name, schema: PaymentEventSchema },
    ]),
    AuditModule,
  ],
  controllers: [PaymentsController],
  providers: [BankTransferConfigService, BankTransferService, PaymentConfirmationService],
  exports: [BankTransferConfigService, BankTransferService, PaymentConfirmationService],
})
export class PaymentsModule {}
