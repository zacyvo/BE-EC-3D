import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { NotificationJob, NotificationJobSchema } from './schemas/notification-job.schema';
import { ZaloBotRecipient, ZaloBotRecipientSchema } from './schemas/zalo-bot-recipient.schema';
import { AuditModule } from '../audit/audit.module';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotClient } from './zalo-bot.client';
import { ZaloOwnerRecipientService } from './zalo-owner-recipient.service';
import { OrderNotificationService } from './order-notification.service';
import { ZaloBotWebhookController } from './zalo-bot-webhook.controller';
import { ZaloBotAdminController } from './zalo-bot-admin.controller';
import { ZaloZbsModule } from '../zalo-zbs/zalo-zbs.module';

/** Owner notifications via Zalo Bot (ORDER_CREATED → shop owner's Zalo). Also hosts the
 * ORDER_CREATED entry point for the customer ZBS confirmation (ZaloZbsModule), which has its
 * own credentials and worker. See docs/ZALO_BOT_INTEGRATION.md, docs/ZALO_ZBS_INTEGRATION.md. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: NotificationJob.name, schema: NotificationJobSchema },
      { name: ZaloBotRecipient.name, schema: ZaloBotRecipientSchema },
    ]),
    AuditModule,
    ZaloZbsModule,
  ],
  controllers: [ZaloBotWebhookController, ZaloBotAdminController],
  providers: [ZaloBotConfigService, ZaloBotClient, ZaloOwnerRecipientService, OrderNotificationService],
  exports: [OrderNotificationService, ZaloBotConfigService],
})
export class ZaloBotModule {}
