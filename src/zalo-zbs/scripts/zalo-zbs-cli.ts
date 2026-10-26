import * as dotenv from 'dotenv';
import mongoose, { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Order, OrderDocument, OrderSchema, OrderStatus } from '../../orders/schemas/order.schema';
import { NotificationJob, NotificationJobDocument, NotificationJobSchema } from '../../zalo-bot/schemas/notification-job.schema';
import { AuditService } from '../../audit/audit.service';
import { ZbsCredential, ZbsCredentialDocument, ZbsCredentialSchema } from '../schemas/zbs-credential.schema';
import {
  ZbsTemplateVerification,
  ZbsTemplateVerificationDocument,
  ZbsTemplateVerificationSchema,
} from '../schemas/zbs-template-verification.schema';
import { ZaloZbsConfigService } from '../zalo-zbs.config';
import { ZbsApiClient } from '../zbs-api.client';
import { ZbsAuthService } from '../zbs-auth.service';
import { ZbsOrderConfirmationService } from '../zbs-order-confirmation.service';
import { ZbsTemplateService } from '../zbs-template.service';
import { maskZbsPhone, normalizeVnPhone } from '../zbs-phone';
import { buildTrackingId, mapOrderToTemplateData, ZbsOrderInput } from '../zbs-template.mapper';
import { mapPromotionToTemplateData } from '../zbs-promotion.mapper';
import { Promotion, PromotionSchema } from '../../promotions/schemas/promotion.schema';
import { ZBS_TEMPLATE_PROMOTION } from '../zalo-zbs.constants';

dotenv.config();

const USAGE = `Usage: npm run zalo-zbs -- <command>
  validate                                  local config check (no network, no DB)
  status                                    token + template state from DB (no network)
  exchange-code --code <c> [--verifier <v>] --confirm
                                            store OA tokens from an authorization code
  refresh --confirm                         spend the refresh token now (rotates it)
  verify-template                           GET /template/info/v2 for the configured template
  check-delivery --job <notificationJobId>  GET /message/status for an ACCEPTED job
  send-test --phone <0xxxxxxxxx> [--order <orderId>] [--dev] --confirm
                                            ONE real (paid) template send to an AUTHORIZED test phone
  verify-promotion-template                 GET /template/info/v2 for ZALO_ZBS_TEMPLATE_PROMOTION
  send-test-promotion --phone <0xxxxxxxxx> --promotion <id> --coupon <couponId> [--dev] --confirm
                                            ONE real (paid) promotion send to an AUTHORIZED test phone`;

/**
 * Operator CLI for ZBS activation (docs/ZALO_ZBS_INTEGRATION.md §16). Reads ZALO_ZBS_* and
 * MONGODB_URI from .env / the shell. Never prints tokens or full phone numbers. Every
 * command that spends a token or a paid message requires --confirm.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => rest.includes(name);
  const arg = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const print = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value, null, 2));
  const configService = new ZaloZbsConfigService(new ConfigService(process.env));

  if (command === 'validate') {
    print('readiness', configService.readiness());
    return;
  }
  if (!command || !['status', 'exchange-code', 'refresh', 'verify-template', 'check-delivery', 'send-test', 'verify-promotion-template', 'send-test-promotion'].includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d');
  try {
    const OrderModel = mongoose.model(Order.name, OrderSchema) as unknown as Model<OrderDocument>;
    const JobModel = mongoose.model(NotificationJob.name, NotificationJobSchema) as unknown as Model<NotificationJobDocument>;
    const CredModel = mongoose.model(ZbsCredential.name, ZbsCredentialSchema) as unknown as Model<ZbsCredentialDocument>;
    const TplModel = mongoose.model(
      ZbsTemplateVerification.name,
      ZbsTemplateVerificationSchema,
    ) as unknown as Model<ZbsTemplateVerificationDocument>;
    const client = new ZbsApiClient(configService);
    const auth = new ZbsAuthService(CredModel, configService, client);
    const audit = { log: async () => undefined } as unknown as AuditService;
    const templates = new ZbsTemplateService(TplModel, client, auth);
    const service = new ZbsOrderConfirmationService(OrderModel, JobModel, configService, client, auth, audit, templates);

    const promotionTarget = () => {
      const cfg = configService.get();
      return {
        templateKey: ZBS_TEMPLATE_PROMOTION,
        templateId: cfg.templateIdPromotion,
        mapping: configService.promotionParamMapping(cfg).mapping,
        manuallyVerified: !!cfg.promotionTemplateManuallyVerified && cfg.promotionTemplateManuallyVerified === cfg.templateIdPromotion,
        templateIdEnv: 'ZALO_ZBS_TEMPLATE_PROMOTION',
        manualEnv: 'ZALO_ZBS_PROMOTION_TEMPLATE_MANUALLY_VERIFIED',
      };
    };

    switch (command) {
      case 'verify-promotion-template':
        print('promotion-readiness', configService.promotionReadiness());
        print('verify-promotion-template', await templates.verify(promotionTarget()));
        return;

      case 'send-test-promotion': {
        const phone = normalizeVnPhone(arg('--phone'));
        const promotionId = arg('--promotion');
        const couponId = arg('--coupon');
        if (!phone.ok || !promotionId || !couponId || !flag('--confirm')) {
          console.error(
            'Cần --phone <SĐT test ĐÃ ĐỒNG Ý nhận tin> --promotion <id> --coupon <couponId> và --confirm. Đây là 1 tin ZBS thật (có tính phí).',
          );
          process.exitCode = 1;
          return;
        }
        const cfg = configService.get();
        const gate = await templates.gate(promotionTarget());
        if (!gate.ready) {
          console.error(`Template khuyến mãi chưa sẵn sàng: ${gate.errorCode} — ${gate.message}`);
          process.exitCode = 1;
          return;
        }
        const PromotionModel = mongoose.model(Promotion.name, PromotionSchema);
        const promo = await PromotionModel.findById(promotionId).lean().exec();
        const coupon = promo?.coupons.find((c) => c._id.toString() === couponId);
        if (!promo || !coupon) {
          console.error('Không tìm thấy chương trình/coupon');
          process.exitCode = 1;
          return;
        }
        const mapped = mapPromotionToTemplateData(
          { customerName: 'Khách thử nghiệm', promotion: promo, coupon },
          configService.promotionParamMapping(cfg).mapping,
          gate.specs,
        );
        if (!mapped.ok) {
          console.error(`Map dữ liệu thất bại: ${mapped.errorCode} — ${mapped.errorMessage}`);
          process.exitCode = 1;
          return;
        }
        const token = await auth.getAccessToken();
        if (!token.ok) {
          print('auth', token);
          process.exitCode = 1;
          return;
        }
        const trackingId = `TESTPR${new Types.ObjectId().toString()}`;
        console.log(`Gửi template ${cfg.templateIdPromotion} tới ${maskZbsPhone(phone.phone)} (tracking ${trackingId})`);
        print('template_data', mapped.templateData);
        const res = await client.sendTemplate(token.accessToken, {
          phone: phone.phone,
          templateId: cfg.templateIdPromotion,
          templateData: mapped.templateData,
          trackingId,
          developmentMode: flag('--dev'),
        });
        print('send-test-promotion', res);
        if (res.ok) console.log('✅ Zalo đã NHẬN yêu cầu (error=0). Hãy xác nhận trên điện thoại test rằng tin đã tới.');
        return;
      }

      case 'status':
        print('credentials', await auth.statusView());
        print('template', await service.templateView());
        print('counts', await service.statusCounts());
        return;

      case 'exchange-code': {
        const code = arg('--code');
        if (!code || !flag('--confirm')) {
          console.error('Cần --code <authorization_code> và --confirm (mã chỉ dùng được 1 lần, hết hạn sau 10 phút).');
          process.exitCode = 1;
          return;
        }
        const res = await auth.exchangeAuthorizationCode(code, arg('--verifier'));
        print('exchange-code', res.ok ? { ok: true } : res);
        if (res.ok) print('credentials', await auth.statusView());
        return;
      }

      case 'refresh': {
        if (!flag('--confirm')) {
          console.error('Refusing: refresh spends the single-use refresh token (a new one is stored). Re-run with --confirm.');
          process.exitCode = 1;
          return;
        }
        const res = await auth.forceRefresh();
        print('refresh', res.ok ? { ok: true } : res);
        print('credentials', await auth.statusView());
        return;
      }

      case 'verify-template':
        print('verify-template', await service.verifyTemplate());
        print('template', await service.templateView());
        return;

      case 'check-delivery': {
        const id = arg('--job');
        if (!id) {
          console.error('Cần --job <notificationJobId>');
          process.exitCode = 1;
          return;
        }
        print('check-delivery', await service.checkDelivery(id));
        return;
      }

      case 'send-test': {
        const phone = normalizeVnPhone(arg('--phone'));
        if (!phone.ok || !flag('--confirm')) {
          console.error(
            'Cần --phone <SĐT test ĐÃ ĐƯỢC ĐỒNG Ý nhận tin> và --confirm. Đây là 1 tin ZBS thật (có tính phí) — không dùng SĐT khách hàng thật.',
          );
          process.exitCode = 1;
          return;
        }
        const cfg = configService.get();
        const gate = await service.templateGate(cfg);
        if (!gate.ready) {
          console.error(`Template chưa sẵn sàng: ${gate.errorCode} — ${gate.message}`);
          process.exitCode = 1;
          return;
        }
        const orderId = arg('--order');
        const order: ZbsOrderInput = orderId
          ? ((await OrderModel.findById(orderId).lean().exec()) as unknown as ZbsOrderInput)
          : {
              _id: new Types.ObjectId().toString(),
              createdAt: new Date(),
              status: OrderStatus.PENDING,
              items: [{ quantity: 1 }],
              shippingInfo: { recipientName: 'Khách thử nghiệm' },
              total: 259000,
              paidAmount: 0,
            };
        if (!order) {
          console.error('Không tìm thấy đơn');
          process.exitCode = 1;
          return;
        }
        const mapped = mapOrderToTemplateData(order, configService.paramMapping(cfg).mapping, {
          orderUrlBase: cfg.orderUrlBase,
          specs: gate.specs,
        });
        if (!mapped.ok) {
          console.error(`Map dữ liệu thất bại: ${mapped.errorCode} — ${mapped.errorMessage}`);
          process.exitCode = 1;
          return;
        }
        const token = await auth.getAccessToken();
        if (!token.ok) {
          print('auth', token);
          process.exitCode = 1;
          return;
        }
        // Distinct tracking id: a test send must never collide with the real order's one.
        const trackingId = `TEST${buildTrackingId(order._id.toString())}`.slice(0, 48);
        console.log(`Gửi template ${cfg.templateIdOrderConfirmation} tới ${maskZbsPhone(phone.phone)} (tracking ${trackingId}, params: ${Object.keys(mapped.templateData).join(', ')})`);
        const res = await client.sendTemplate(token.accessToken, {
          phone: phone.phone,
          templateId: cfg.templateIdOrderConfirmation,
          templateData: mapped.templateData,
          trackingId,
          developmentMode: flag('--dev'),
        });
        print('send-test', res);
        if (res.ok) console.log('✅ Zalo đã NHẬN yêu cầu (error=0). Hãy xác nhận trên điện thoại test rằng tin đã tới.');
        return;
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('❌', (err as Error).message);
  process.exit(1);
});
