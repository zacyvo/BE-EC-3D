import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { BannersService } from './banners.service';
import {
  CreateBannerDto, PublicBannersQueryDto, ReorderBannersDto, UpdateBannerDto,
} from './dto/banner.dto';
import { BannerPlacement } from './banner.constants';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Public (trang chủ) ──────────────────────────────────────────────────────

@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  /** Banner đang chạy, đã sắp xếp. Không có banner nào → [] và trang chủ hiển thị mặc định. */
  @Get()
  findPublic(@Query() query: PublicBannersQueryDto) {
    return this.bannersService.findPublic(query.placement);
  }

  @Post(':id/click')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async click(@Param('id') id: string) {
    await this.bannersService.trackClick(id);
    return { ok: true };
  }
}

// ─── Admin ───────────────────────────────────────────────────────────────────

@Controller('admin/banners')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class AdminBannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  findAll(@Query() query: PublicBannersQueryDto) {
    return this.bannersService.findAllAdmin(query.placement as BannerPlacement | undefined);
  }

  /** Đặt trước ':id' để "reorder" không bị bắt như một id. */
  @Patch('reorder')
  reorder(@Body() dto: ReorderBannersDto, @CurrentUser() staff: { sub: string }) {
    return this.bannersService.reorder(dto, staff.sub);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.bannersService.findOneAdmin(id);
  }

  @Post()
  create(@Body() dto: CreateBannerDto, @CurrentUser() staff: { sub: string }) {
    return this.bannersService.create(dto, staff.sub);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto, @CurrentUser() staff: { sub: string }) {
    return this.bannersService.update(id, dto, staff.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.bannersService.remove(id, staff.sub);
  }
}
