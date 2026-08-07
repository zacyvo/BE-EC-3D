import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingDto } from './dto/setting.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Public User API ─────────────────────────────────────────────────────────

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  findOne() {
    return this.settingsService.get();
  }
}

// ─── Admin API ────────────────────────────────────────────────────────────────

@Controller('admin/settings')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminSettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  findOne() {
    return this.settingsService.get();
  }

  @Patch()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  update(@Body() dto: UpdateSettingDto, @CurrentUser() staff: { sub: string }) {
    return this.settingsService.update(dto, staff.sub);
  }
}
