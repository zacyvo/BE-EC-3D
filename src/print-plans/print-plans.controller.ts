import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Query, UseGuards, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { PrintPlansService } from './print-plans.service';
import {
  CreatePrintPlanDto, UpdatePrintPlanDto, UpdatePrintPlanStatusDto,
} from './dto/print-plan.dto';
import { PrintPlanStatus } from './schemas/print-plan.schema';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('admin/print-plans')
@UseGuards(JwtStaffGuard, RolesGuard)
export class PrintPlansController {
  constructor(private readonly service: PrintPlansService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  create(
    @Body() dto: CreatePrintPlanDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.create(dto, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: PrintPlanStatus,
    @Query('source') source?: string,
    @Query('search') search?: string,
  ) {
    return this.service.findAll({ page, limit, status, source, search });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePrintPlanDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.update(id, dto, staff.sub);
  }

  @Patch(':id/status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePrintPlanStatusDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.updateStatus(id, dto, staff.sub);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async remove(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    await this.service.softDelete(id, staff.sub);
    return { message: 'Đã xóa kế hoạch in' };
  }
}
