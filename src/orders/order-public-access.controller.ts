import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { OrderPublicAccessService } from './order-public-access.service';
import { OrderPublicAccessDto, PublicOrderVerifyDto } from './dto/order.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/** "Link xem đơn" — customer opens /order/<token> with phone + security code, no login. */
@Controller('orders/public')
export class PublicOrderAccessController {
  constructor(private readonly service: OrderPublicAccessService) {}

  /** Bare minimum for the unlock screen (order code + masked phone). */
  @Get(':token/meta')
  getMeta(@Param('token') token: string) {
    return this.service.getMeta(token);
  }

  /** Phone + security code → short-lived access JWT. Rate-limited + temporary lock. */
  @Post(':token/verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Param('token') token: string, @Body() dto: PublicOrderVerifyDto) {
    return this.service.verify(token, dto.phone, dto.securityCode);
  }

  @Get(':token')
  getOrder(@Param('token') token: string, @Headers('x-order-access') accessJwt?: string) {
    return this.service.getOrder(token, accessJwt);
  }
}

@Controller('admin/orders')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminOrderAccessController {
  constructor(private readonly service: OrderPublicAccessService) {}

  /** Xem link + mã bảo mật (or re-issue them) — re-confirms the staff password. */
  @Post(':id/public-access')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  revealOrIssue(
    @Param('id') id: string,
    @Body() dto: OrderPublicAccessDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.revealOrIssue(id, staff.sub, dto.password, dto.regenerate === true);
  }
}
