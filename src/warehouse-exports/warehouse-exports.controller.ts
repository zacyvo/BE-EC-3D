import {
  Controller, Get, Post, Delete,
  Body, Param, Query, UseGuards,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { WarehouseExportsService } from './warehouse-exports.service';
import { CreateWarehouseExportDto } from './dto/warehouse-export.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('admin/warehouse-exports')
@UseGuards(JwtStaffGuard, RolesGuard)
export class WarehouseExportsController {
  constructor(private readonly service: WarehouseExportsService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.SELLER)
  create(
    @Body() dto: CreateWarehouseExportDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.create(dto, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.service.findAll({ page, limit, search, fromDate, toDate });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Warehouse export deleted' };
  }
}
