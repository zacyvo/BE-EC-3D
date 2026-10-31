import {
  Body, Controller, DefaultValuePipe, Get, Param, ParseEnumPipe, ParseIntPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { OrderReturnsService } from './order-returns.service';
import {
  ApproveReturnDto,
  CompleteRefundDto,
  CreateReturnRequestDto,
  InspectReturnDto,
  ReceiveReturnDto,
  RejectReturnDto,
  ReturnShipmentDto,
} from './dto/order-return.dto';
import { ReturnStatus } from '../orders/schemas/order.schema';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/** Customer side, nested under the order: /orders/:id/return... */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderReturnsController {
  constructor(private readonly returnsService: OrderReturnsService) {}

  @Get(':id/return-eligibility')
  eligibility(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.returnsService.getEligibility(id, user.sub);
  }

  /** Customer asks to return (part of) a delivered order — notifies the owner. */
  @Post(':id/return')
  create(@Param('id') id: string, @CurrentUser() user: { sub: string }, @Body() dto: CreateReturnRequestDto) {
    return this.returnsService.createRequest(id, user.sub, dto);
  }

  /** Customer withdraws the request — only before the parcel is sent back. */
  @Post(':id/return/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.returnsService.cancelRequest(id, user.sub);
  }

  /** Customer enters (or corrects) the return parcel's tracking code. */
  @Post(':id/return/shipment')
  ship(@Param('id') id: string, @CurrentUser() user: { sub: string }, @Body() dto: ReturnShipmentDto) {
    return this.returnsService.submitShipment(id, user.sub, dto);
  }
}

/** Shop side: /admin/order-returns/:orderId/... (the return is keyed by its order). */
@Controller('admin/order-returns')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminOrderReturnsController {
  constructor(private readonly returnsService: OrderReturnsService) {}

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status', new ParseEnumPipe(ReturnStatus, { optional: true })) status?: ReturnStatus,
    @Query('search') search?: string,
  ) {
    return this.returnsService.findAllAdmin({ page, limit, status, search });
  }

  @Post(':orderId/approve')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  approve(@Param('orderId') orderId: string, @CurrentUser() staff: { sub: string }, @Body() dto: ApproveReturnDto) {
    return this.returnsService.approve(orderId, staff.sub, dto);
  }

  @Post(':orderId/reject')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  reject(@Param('orderId') orderId: string, @CurrentUser() staff: { sub: string }, @Body() dto: RejectReturnDto) {
    return this.returnsService.reject(orderId, staff.sub, dto);
  }

  @Post(':orderId/receive')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  receive(@Param('orderId') orderId: string, @CurrentUser() staff: { sub: string }, @Body() dto: ReceiveReturnDto) {
    return this.returnsService.markReceived(orderId, staff.sub, dto);
  }

  /** Decides the refund amount — money, so ADMIN and above only (same as order cancellation). */
  @Post(':orderId/inspect')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  inspect(@Param('orderId') orderId: string, @CurrentUser() staff: { sub: string }, @Body() dto: InspectReturnDto) {
    return this.returnsService.inspect(orderId, staff.sub, dto);
  }

  @Post(':orderId/refund')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  refund(@Param('orderId') orderId: string, @CurrentUser() staff: { sub: string }, @Body() dto: CompleteRefundDto) {
    return this.returnsService.completeRefund(orderId, staff.sub, dto);
  }
}
