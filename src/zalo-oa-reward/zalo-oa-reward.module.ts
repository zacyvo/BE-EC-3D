import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { PromotionsModule } from '../promotions/promotions.module';
import { UsersModule } from '../users/users.module';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import { ZaloOaIdentityService } from './zalo-oa-identity.service';
import { ZaloOaRecipientService } from './zalo-oa-recipient.service';
import { ZaloOaCouponAssignmentService } from './zalo-oa-coupon-assignment.service';
import { ZaloOaRewardService } from './zalo-oa-reward.service';
import { ZaloOaWebhookService } from './zalo-oa-webhook.service';
import { ZaloOaRewardController, ZaloOaRewardPublicController, ZaloOaWebhookController } from './zalo-oa-reward.controller';
import { ZaloOaRewardSession, ZaloOaRewardSessionSchema } from './schemas/zalo-oa-reward-session.schema';
import { ZaloOaFollower, ZaloOaFollowerSchema } from './schemas/zalo-oa-follower.schema';
import { ZaloOaLink, ZaloOaLinkSchema } from './schemas/zalo-oa-link.schema';
import { ZaloOaRewardGrant, ZaloOaRewardGrantSchema } from './schemas/zalo-oa-reward-grant.schema';
import { ZaloOaWebhookEvent, ZaloOaWebhookEventSchema } from './schemas/zalo-oa-webhook-event.schema';

/** Zalo OA welcome reward (20% coupon for following the OA after a storefront order).
 * Independent of ZaloBotModule (owner notifications) and ZaloZbsModule (order confirmation):
 * no shared credentials, webhook or worker, and checkout (OrdersService) is untouched.
 * See docs/ZALO_OA_REWARD_INTEGRATION.md. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: ZaloOaRewardSession.name, schema: ZaloOaRewardSessionSchema },
      { name: ZaloOaFollower.name, schema: ZaloOaFollowerSchema },
      { name: ZaloOaLink.name, schema: ZaloOaLinkSchema },
      { name: ZaloOaRewardGrant.name, schema: ZaloOaRewardGrantSchema },
      { name: ZaloOaWebhookEvent.name, schema: ZaloOaWebhookEventSchema },
    ]),
    PromotionsModule,
    UsersModule,
  ],
  controllers: [ZaloOaRewardController, ZaloOaRewardPublicController, ZaloOaWebhookController],
  providers: [
    ZaloOaRewardConfigService,
    ZaloOaIdentityService,
    ZaloOaRecipientService,
    ZaloOaCouponAssignmentService,
    ZaloOaRewardService,
    ZaloOaWebhookService,
  ],
})
export class ZaloOaRewardModule {}
