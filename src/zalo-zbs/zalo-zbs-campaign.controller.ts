import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { ZbsCampaignMessageStatus } from './schemas/zbs-campaign-message.schema';
import { ZbsPromotionCampaignService } from './zbs-promotion-campaign.service';
import { ConfirmZbsCampaignDto, CreateZbsCampaignDto } from './dto/zbs-campaign.dto';

/** Admin promotion campaigns over ZBS. Reading is ADMIN+, anything that can lead to paid
 * messages (create/confirm/resume) or stop them (pause/cancel) is SUPER_ADMIN only. Never
 * returns full phone numbers or tokens. */
@Controller('admin/zalo-zbs/promotion')
@UseGuards(JwtStaffGuard, RolesGuard)
export class ZaloZbsCampaignController {
  constructor(
    private readonly service: ZbsPromotionCampaignService,
    private readonly auditService: AuditService,
  ) {}

  @Get('status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  status() {
    return this.service.status();
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
      action: 'ZALO_ZBS_PROMOTION_TEMPLATE_VERIFY',
      module: 'zalo-zbs',
      targetId: result.templateId,
      afterData: { ok: result.ok, status: result.status, errorCode: result.errorCode },
    });
    return result;
  }

  @Get('campaigns')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.service.listCampaigns(page, limit);
  }

  @Post('campaigns')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() dto: CreateZbsCampaignDto, @CurrentUser() staff: { sub: string }) {
    return this.service.createDraft(dto, staff.sub);
  }

  @Get('campaigns/:id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  get(@Param('id') id: string) {
    return this.service.getCampaign(id);
  }

  @Get('campaigns/:id/messages')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  messages(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: ZbsCampaignMessageStatus,
  ) {
    const valid = status && Object.values(ZbsCampaignMessageStatus).includes(status) ? status : undefined;
    return this.service.listMessages(id, { status: valid, page, limit });
  }

  @Post('campaigns/:id/confirm')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  confirm(@Param('id') id: string, @Body() dto: ConfirmZbsCampaignDto, @CurrentUser() staff: { sub: string }) {
    return this.service.confirm(id, dto.expectedRecipients, staff.sub);
  }

  @Post('campaigns/:id/pause')
  @Roles(StaffRole.SUPER_ADMIN)
  pause(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.pause(id, staff.sub);
  }

  @Post('campaigns/:id/resume')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resume(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.resume(id, staff.sub);
  }

  @Post('campaigns/:id/cancel')
  @Roles(StaffRole.SUPER_ADMIN)
  cancel(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.cancel(id, staff.sub);
  }

  @Post('messages/:messageId/check-delivery')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  checkDelivery(@Param('messageId') messageId: string, @CurrentUser() staff: { sub: string }) {
    return this.service.checkDelivery(messageId, staff.sub);
  }
}
