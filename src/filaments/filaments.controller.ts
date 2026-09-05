import {
  Controller, Get, Post, Patch,
  Body, Param, Query, UseGuards,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { FilamentsService } from './filaments.service';
import { CreateFilamentImportDto, ExportFilamentDto } from './dto/filament.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('admin/filaments')
@UseGuards(JwtStaffGuard, RolesGuard)
export class FilamentsController {
  constructor(private readonly service: FilamentsService) {}

  @Post('imports')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  createImport(
    @Body() dto: CreateFilamentImportDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.createImport(dto, staff.sub);
  }

  @Get('imports')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findImports(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.service.findImports({ page, limit, fromDate, toDate });
  }

  @Get('units')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findUnits(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: string,
    @Query('color') color?: string,
    @Query('status') status?: string,
  ) {
    return this.service.findUnits({ page, limit, type, color, status });
  }

  @Get('stock')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  getStock() {
    return this.service.getStock();
  }

  @Get('stats')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  getStats(@Query('year', new DefaultValuePipe(0), ParseIntPipe) year: number) {
    return this.service.getStats(year || undefined);
  }

  @Post('export')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.SELLER)
  exportFilament(
    @Body() dto: ExportFilamentDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.exportFilament(dto, staff.sub);
  }

  @Patch('units/:id/deplete')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.SELLER)
  depleteUnit(@Param('id') id: string) {
    return this.service.depleteUnit(id);
  }
}
