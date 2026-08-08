import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { NfcService } from './nfc.service';
import {
  AdminCreateNfcDto,
  PublicActivateDto,
  PublicLoginDto,
  SaveSocialLinksDto,
} from './dto/nfc.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Admin ─────────────────────────────────────────────────────────────────────

@Controller('admin/nfc')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminNfcController {
  constructor(private readonly nfcService: NfcService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  create(@Body() dto: AdminCreateNfcDto, @CurrentUser() staff: { sub: string }) {
    return this.nfcService.create(dto, staff.sub);
  }

  @Get()
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('isActivated') isActivated?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.nfcService.findAll({ page, limit, search, isActivated, isActive });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.nfcService.findById(id);
  }

  @Patch(':id/toggle-active')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  toggleActive(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.nfcService.toggleActive(id, staff.sub);
  }

  @Patch(':id/links')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  updateLinks(
    @Param('id') id: string,
    @Body() dto: SaveSocialLinksDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.nfcService.updateSocialLinksAdmin(id, dto, staff.sub);
  }

  @Post(':id/reset-activation')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  resetActivation(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.nfcService.resetActivation(id, staff.sub);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async remove(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    await this.nfcService.softDelete(id, staff.sub);
    return { message: 'Đã xoá thẻ NFC' };
  }
}

// ─── Public (chủ thẻ truy cập qua NFC_ID/NFC_CODE) ────────────────────────────

@Controller('nfc/public')
export class PublicNfcController {
  constructor(private readonly nfcService: NfcService) {}

  /** Xác định `code` là NFC_ID (trang quản lý) hay NFC_CODE (trang xem công khai) */
  @Get(':code/meta')
  getMeta(@Param('code') code: string) {
    return this.nfcService.resolveMeta(code);
  }

  @Post(':code/activate')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  activate(@Param('code') code: string, @Body() dto: PublicActivateDto) {
    return this.nfcService.activate(code, dto);
  }

  @Post(':code/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Param('code') code: string, @Body() dto: PublicLoginDto) {
    return this.nfcService.login(code, dto);
  }

  @Get(':code')
  getOwnProfile(
    @Param('code') code: string,
    @Headers('x-nfc-access') accessJwt?: string,
  ) {
    return this.nfcService.getOwnProfile(code, accessJwt);
  }

  @Put(':code/links')
  saveLinks(
    @Param('code') code: string,
    @Body() dto: SaveSocialLinksDto,
    @Headers('x-nfc-access') accessJwt?: string,
  ) {
    return this.nfcService.saveSocialLinks(code, accessJwt, dto);
  }

  @Get(':code/view')
  getPublicView(@Param('code') code: string) {
    return this.nfcService.getPublicView(code);
  }
}
