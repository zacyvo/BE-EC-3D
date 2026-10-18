import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { NotificationJob, NotificationJobSchema } from '../zalo-bot/schemas/notification-job.schema';
import { AuditModule } from '../audit/audit.module';
import { ZbsCredential, ZbsCredentialSchema } from './schemas/zbs-credential.schema';
import { ZbsTemplateVerification, ZbsTemplateVerificationSchema } from './schemas/zbs-template-verification.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { ZbsOrderConfirmationService } from './zbs-order-confirmation.service';
import { ZaloZbsAdminController } from './zalo-zbs-admin.controller';

/** Customer order confirmation via Zalo ZBS Template Message (ORDER_CREATED only). Imported
 * by ZaloBotModule, whose OrderNotificationService is the single ORDER_CREATED entry point
 * for checkout. Shares notification_jobs with the Bot, but none of its credentials.
 * See docs/ZALO_ZBS_INTEGRATION.md. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: NotificationJob.name, schema: NotificationJobSchema },
      { name: ZbsCredential.name, schema: ZbsCredentialSchema },
      { name: ZbsTemplateVerification.name, schema: ZbsTemplateVerificationSchema },
    ]),
    AuditModule,
  ],
  controllers: [ZaloZbsAdminController],
  providers: [ZaloZbsConfigService, ZbsApiClient, ZbsAuthService, ZbsOrderConfirmationService],
  exports: [ZbsOrderConfirmationService, ZaloZbsConfigService],
})
export class ZaloZbsModule {}
