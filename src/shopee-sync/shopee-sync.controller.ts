import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ShopeeSyncService } from './shopee-sync.service';
import { CreateSyncSessionDto } from './dto/create-sync-session.dto';
import { ListSnapshotDto } from './dto/list-snapshot.dto';
import { UploadProductDetailDto } from './dto/marketplace-product-upload.dto';
import { ShopeeUploadTokenGuard, UploadSession } from './guards/shopee-upload-token.guard';
import type { ShopeeSyncSessionDocument } from './schemas/shopee-sync-session.schema';

type StaffPrincipal = { sub: string; role: StaffRole };

const STAFF_READ_ROLES = [StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER];
const STAFF_WRITE_ROLES = [StaffRole.SUPER_ADMIN, StaffRole.ADMIN];

@Controller('admin/integrations/shopee')
export class AdminIntegrationsShopeeController {
  constructor(private readonly service: ShopeeSyncService) {}

  @Get('config')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_READ_ROLES)
  getConfig() {
    return this.service.getConfig();
  }

  @Get('sync-sessions/latest')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_READ_ROLES)
  getLatest(@Query('shopId') shopId?: string) {
    return this.service.getLatestSession(shopId);
  }

  @Get('sync-sessions/:id')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_READ_ROLES)
  getById(@Param('id') id: string) {
    return this.service.getSessionById(id);
  }

  @Post('sync-sessions')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_WRITE_ROLES)
  create(@Body() dto: CreateSyncSessionDto, @CurrentUser() staff: StaffPrincipal) {
    return this.service.createSession(dto, staff.sub, staff.role === StaffRole.SUPER_ADMIN);
  }

  /** Called directly by the Chrome Extension's service worker — upload-token auth, not staff JWT. */
  @Post('sync-sessions/:id/list-snapshot')
  @UseGuards(ShopeeUploadTokenGuard)
  uploadListSnapshot(@UploadSession() session: ShopeeSyncSessionDocument, @Body() dto: ListSnapshotDto) {
    return this.service.processListSnapshot(session, dto);
  }

  /** Called directly by the Chrome Extension's service worker — upload-token auth, not staff JWT. */
  @Post('sync-sessions/:id/products/:productId')
  @UseGuards(ShopeeUploadTokenGuard)
  uploadProductDetail(
    @UploadSession() session: ShopeeSyncSessionDocument,
    @Param('productId') productId: string,
    @Body() dto: UploadProductDetailDto,
  ) {
    return this.service.uploadProductDetail(session, productId, dto);
  }

  @Post('sync-sessions/:id/preview')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_WRITE_ROLES)
  preview(@Param('id') id: string) {
    return this.service.preview(id);
  }

  @Post('sync-sessions/:id/commit')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_WRITE_ROLES)
  commit(@Param('id') id: string, @CurrentUser() staff: StaffPrincipal) {
    return this.service.commit(id, staff.sub);
  }

  @Delete('sync-sessions/:id')
  @UseGuards(JwtStaffGuard, RolesGuard)
  @Roles(...STAFF_WRITE_ROLES)
  cancel(@Param('id') id: string, @CurrentUser() staff: StaffPrincipal) {
    if (!staff) throw new ForbiddenException();
    return this.service.cancel(id, staff.sub);
  }
}
