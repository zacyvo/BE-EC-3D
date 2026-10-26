import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Promotion, PromotionSchema } from '../promotions/schemas/promotion.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { NotificationJob, NotificationJobSchema } from '../zalo-bot/schemas/notification-job.schema';
import { AuditModule } from '../audit/audit.module';
import { ZbsCredential, ZbsCredentialSchema } from './schemas/zbs-credential.schema';
import { ZbsTemplateVerification, ZbsTemplateVerificationSchema } from './schemas/zbs-template-verification.schema';
import { ZbsCampaign, ZbsCampaignSchema } from './schemas/zbs-campaign.schema';
import { ZbsCampaignMessage, ZbsCampaignMessageSchema } from './schemas/zbs-campaign-message.schema';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { ZbsOrderConfirmationService } from './zbs-order-confirmation.service';
import { ZbsTemplateService } from './zbs-template.service';
import { ZbsPromotionCampaignService } from './zbs-promotion-campaign.service';
import { ZaloZbsAdminController } from './zalo-zbs-admin.controller';
import { ZaloZbsCampaignController } from './zalo-zbs-campaign.controller';

/** Customer messages via Zalo ZBS Template Message: the automatic order confirmation
 * (ORDER_CREATED) and admin-confirmed promotion campaigns. Imported by ZaloBotModule, whose
 * OrderNotificationService is the single ORDER_CREATED entry point for checkout. Shares
 * notification_jobs with the Bot (order confirmations only), but none of its credentials.
 * See docs/ZALO_ZBS_INTEGRATION.md. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: NotificationJob.name, schema: NotificationJobSchema },
      { name: ZbsCredential.name, schema: ZbsCredentialSchema },
      { name: ZbsTemplateVerification.name, schema: ZbsTemplateVerificationSchema },
      { name: ZbsCampaign.name, schema: ZbsCampaignSchema },
      { name: ZbsCampaignMessage.name, schema: ZbsCampaignMessageSchema },
      { name: Promotion.name, schema: PromotionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
  ],
  controllers: [ZaloZbsAdminController, ZaloZbsCampaignController],
  providers: [
    ZaloZbsConfigService,
    ZbsApiClient,
    ZbsAuthService,
    ZbsTemplateService,
    ZbsOrderConfirmationService,
    ZbsPromotionCampaignService,
  ],
  exports: [ZbsOrderConfirmationService, ZaloZbsConfigService],
})
export class ZaloZbsModule {}
