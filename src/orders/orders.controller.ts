import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Query, UseGuards, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto, AdminCreateOrderDto } from './dto/order.dto';
import { OrderStatus } from './schemas/order.schema';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(@CurrentUser() user: { sub: string }, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.sub, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: { sub: string },
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.ordersService.findByUser(user.sub, { page, limit });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.ordersService.findByIdForUser(id, user.sub);
  }
}

@Controller('admin/orders')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('stats')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  getUserStats(@Query('userId') userId: string) {
    return this.ordersService.getUserStats(userId);
  }

  @Post('for-user')
  @Roles(StaffRole.SUPER_ADMIN)
  createForUser(
    @Body() dto: AdminCreateOrderDto,
    @CurrentUser() staff: { sub: string; role: StaffRole },
  ) {
    return this.ordersService.createForAdmin(staff.sub, dto);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: OrderStatus,
    @Query('userId') userId?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findAllAdmin({ page, limit, status, userId, search });
  }

  @Patch(':id/status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() staff: { sub: string; role: StaffRole },
  ) {
    return this.ordersService.updateStatus(id, dto, staff.sub, staff.role);
  }

  @Get(':id/versions')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  getVersions(@Param('id') id: string) {
    return this.ordersService.getOrderVersions(id);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async softDelete(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    await this.ordersService.softDelete(id, staff.sub);
    return { message: 'Order deleted' };
  }
}
