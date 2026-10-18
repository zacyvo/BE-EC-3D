import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { NotificationStatus } from '../zalo-bot/zalo-bot.constants';
import { ZaloZbsConfigService } from './zalo-zbs.config';
import { ZbsAuthService } from './zbs-auth.service';
import { ZbsOrderConfirmationService } from './zbs-order-confirmation.service';
import { RetryZbsNotificationDto } from './dto/zalo-zbs-admin.dto';

/** Staff-only view of the customer ZBS integration. Never returns tokens, the app secret or
 * full phone numbers. There is deliberately NO "send test message" endpoint: ZBS messages
 * are paid and go to real customers — test sends are CLI-only (see docs §14). */
@Controller('admin/zalo-zbs')
@UseGuards(JwtStaffGuard, RolesGuard)
export class ZaloZbsAdminController {
  constructor(
    private readonly configService: ZaloZbsConfigService,
    private readonly auth: ZbsAuthService,
    private readonly service: ZbsOrderConfirmationService,
    private readonly auditService: AuditService,
  ) {}

  @Get('status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async status() {
    const [credentials, template, counts, stats] = await Promise.all([
      this.auth.statusView(),
      this.service.templateView(),
      this.service.statusCounts(),
      this.service.stats(),
    ]);
    return { config: this.configService.readiness(), credentials, template, counts, stats };
  }

  @Post('template/verify')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyTemplate(@CurrentUser() staff: { sub: string }) {
    const result = await this.service.verifyTemplate();
    await this.auditService.log({
      actorId: staff.sub,
      actorType: 'staff',
      action: 'ZALO_ZBS_TEMPLATE_VERIFY',
      module: 'zalo-zbs',
      targetId: result.templateId,
      afterData: { ok: result.ok, status: result.status, errorCode: result.errorCode },
    });
    return result;
  }

  @Post('auth/refresh')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async refreshToken(@CurrentUser() staff: { sub: string }) {
    const res = await this.auth.forceRefresh();
    await this.auditService.log({
      actorId: staff.sub,
      actorType: 'staff',
      action: 'ZALO_ZBS_TOKEN_REFRESH',
      module: 'zalo-zbs',
      afterData: res.ok ? { ok: true } : { ok: false, errorCode: res.errorCode, errorClass: res.errorClass },
    });
    return res.ok
      ? { ok: true, credentials: await this.auth.statusView() }
      : { ok: false, errorClass: res.errorClass, errorCode: res.errorCode, description: res.description };
  }

  @Get('notifications')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  listNotifications(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: NotificationStatus,
    @Query('orderCode') orderCode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const validStatus = status && Object.values(NotificationStatus).includes(status) ? status : undefined;
    return this.service.listJobs({
      status: validStatus,
      orderCode: orderCode || undefined,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      page,
      limit,
    });
  }

  @Post('notifications/:id/retry')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  retry(@Param('id') id: string, @Body() dto: RetryZbsNotificationDto, @CurrentUser() staff: { sub: string }) {
    return this.service.retryJob(id, staff.sub, dto.confirmUnknownOutcome === true);
  }

  @Post('notifications/:id/check-delivery')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  checkDelivery(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.checkDelivery(id, staff.sub);
  }
}

function parseDate(v: string | undefined, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new BadRequestException(`${name} không phải ngày hợp lệ`);
  // A bare "to" date (YYYY-MM-DD) means the whole day.
  if (name === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUTCHours(23, 59, 59, 999);
  return d;
}
