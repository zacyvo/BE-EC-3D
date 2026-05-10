import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Query, UseGuards, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { CustomOrdersService } from './custom-orders.service';
import { CreateCustomOrderDto, UpdateCustomOrderStatusDto } from './dto/custom-order.dto';
import { CustomOrderStatus } from './schemas/custom-order.schema';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('custom-orders')
@UseGuards(JwtAuthGuard)
export class CustomOrdersController {
  constructor(private readonly service: CustomOrdersService) {}

  @Post()
  create(
    @CurrentUser() user: { sub: string },
    @Body() dto: CreateCustomOrderDto,
  ) {
    return this.service.create(user.sub, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: { sub: string },
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.service.findByUser(user.sub, { page, limit });
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.findByIdForUser(id, user.sub);
  }
}

@Controller('admin/custom-orders')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminCustomOrdersController {
  constructor(private readonly service: CustomOrdersService) {}

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: CustomOrderStatus,
    @Query('search') search?: string,
  ) {
    return this.service.findAllAdmin({ page, limit, status, search });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findOne(@Param('id') id: string) {
    return this.service.findByIdAdmin(id);
  }

  @Patch(':id/status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateCustomOrderStatusDto,
    @CurrentUser() staff: { sub: string; role: StaffRole },
  ) {
    return this.service.updateStatus(id, dto, staff.sub, staff.role);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async softDelete(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    await this.service.softDelete(id, staff.sub);
    return { message: 'Đã xóa yêu cầu' };
  }
}
