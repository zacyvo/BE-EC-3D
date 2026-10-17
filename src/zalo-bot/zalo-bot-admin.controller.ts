import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloOwnerRecipientService } from './zalo-owner-recipient.service';
import { OrderNotificationService } from './order-notification.service';
import { NotificationStatus } from './zalo-bot.constants';
import { RetryNotificationDto, SendTestMessageDto } from './dto/zalo-bot-admin.dto';

/** Staff-only management of the Zalo Bot integration. Never returns the token, the webhook
 * secret, or unmasked chat ids. */
@Controller('admin/zalo-bot')
@UseGuards(JwtStaffGuard, RolesGuard)
export class ZaloBotAdminController {
  constructor(
    private readonly configService: ZaloBotConfigService,
    private readonly recipients: ZaloOwnerRecipientService,
    private readonly notifications: OrderNotificationService,
  ) {}

  @Get('status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async status() {
    return {
      config: this.configService.readiness(),
      counts: await this.notifications.statusCounts(),
      webhookPath: '/api/v1/webhooks/zalo-bot',
    };
  }

  @Get('recipients')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  listRecipients() {
    return this.recipients.listForAdmin();
  }

  @Patch('recipients/:id/approve')
  @Roles(StaffRole.SUPER_ADMIN)
  approve(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.recipients.approve(id, staff.sub);
  }

  @Patch('recipients/:id/revoke')
  @Roles(StaffRole.SUPER_ADMIN)
  revoke(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.recipients.revoke(id, staff.sub);
  }

  @Post('recipients/test-message')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendTest(@Body() dto: SendTestMessageDto, @CurrentUser() staff: { sub: string }) {
    return this.notifications.sendTestMessage(dto.recipientKey, staff.sub);
  }

  @Get('notifications')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  listNotifications(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: NotificationStatus,
    @Query('orderId') orderId?: string,
  ) {
    const validStatus = status && Object.values(NotificationStatus).includes(status) ? status : undefined;
    return this.notifications.listJobs({ status: validStatus, orderId: orderId || undefined, page, limit });
  }

  @Post('notifications/:id/retry')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  retry(@Param('id') id: string, @Body() dto: RetryNotificationDto, @CurrentUser() staff: { sub: string }) {
    return this.notifications.retryJob(id, staff.sub, dto.confirmUnknownOutcome === true);
  }
}
