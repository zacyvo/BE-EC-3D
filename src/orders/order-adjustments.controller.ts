import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrderAdjustmentService } from './order-adjustment.service';
import {
  AcceptOrderAdjustmentDto,
  CompleteAdjustmentSettlementDto,
  ProposeOrderAdjustmentDto,
  RejectOrderAdjustmentDto,
  WithdrawOrderAdjustmentDto,
} from './dto/order.dto';

/** Customer side of "Điều chỉnh đơn hàng" (own orders only). */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderAdjustmentsController {
  constructor(private readonly adjustments: OrderAdjustmentService) {}

  /** Agree to the shop's proposal — applies it; refund account / extra payment method as needed. */
  @Post(':id/adjustment/accept')
  accept(@Param('id') id: string, @CurrentUser() user: { sub: string }, @Body() dto: AcceptOrderAdjustmentDto) {
    return this.adjustments.accept(id, user.sub, dto);
  }

  /** Decline the proposal — the order stays as it was. */
  @Post(':id/adjustment/reject')
  reject(@Param('id') id: string, @CurrentUser() user: { sub: string }, @Body() dto: RejectOrderAdjustmentDto) {
    return this.adjustments.reject(id, user.sub, dto);
  }

  /** VietQR instructions for the extra amount of an accepted adjustment. */
  @Get(':id/adjustment/payment')
  getPayment(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.adjustments.getExtraPaymentForUser(id, user.sub);
  }

  /** "Tôi đã chuyển khoản" for the extra amount — a claim only. */
  @Post(':id/adjustment/payment/report')
  reportPayment(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.adjustments.reportExtraPayment(id, user.sub);
  }
}

/** Admin side: only a Super Admin edits an order; recording the settlement follows the payment
 * confirmation roles (Super Admin / Admin). */
@Controller('admin/orders')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminOrderAdjustmentsController {
  constructor(private readonly adjustments: OrderAdjustmentService) {}

  @Post(':id/adjustment')
  @Roles(StaffRole.SUPER_ADMIN)
  propose(
    @Param('id') id: string,
    @Body() dto: ProposeOrderAdjustmentDto,
    @CurrentUser() staff: { sub: string; email?: string },
  ) {
    return this.adjustments.propose(id, { staffId: staff.sub, staffName: staff.email }, dto);
  }

  @Patch(':id/adjustment/withdraw')
  @Roles(StaffRole.SUPER_ADMIN)
  withdraw(@Param('id') id: string, @Body() dto: WithdrawOrderAdjustmentDto, @CurrentUser() staff: { sub: string }) {
    return this.adjustments.withdraw(id, staff.sub, dto.reason);
  }

  /** "Đã hoàn tiền chênh lệch" / "Đã nhận tiền thêm". */
  @Patch(':id/adjustment/settlement/complete')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  completeSettlement(
    @Param('id') id: string,
    @Body() dto: CompleteAdjustmentSettlementDto,
    @CurrentUser() staff: { sub: string; email?: string },
  ) {
    return this.adjustments.completeSettlement(id, { staffId: staff.sub, staffName: staff.email }, dto);
  }
}
