import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { OrderPublicAccessService } from './order-public-access.service';
import { OrdersService } from './orders.service';
import { CreateOrderDto, OrderPublicAccessDto, PublicOrderLookupDto, PublicOrderVerifyDto, ReportPaymentDto } from './dto/order.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ClientIpThrottlerGuard } from '../common/client-ip-throttler.guard';

/** "Mua không cần đăng nhập" — storefront checkout without an account. */
@Controller('orders/guest-checkout')
export class GuestCheckoutController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly access: OrderPublicAccessService,
  ) {}

  /** Places the order for a guest ("user tạm" by recipient phone). The response carries the
   * "Link xem đơn" + security code (shown once on the success page) and an already-open session. */
  @Post()
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 8, ttl: 10 * 60_000 } })
  async create(@Body() dto: CreateOrderDto) {
    const order = await this.ordersService.createAsGuest(dto);
    const credentials = this.access.credentialsOfNewOrder(order)!;
    return {
      order: this.access.toPublicView(order),
      publicAccess: {
        token: order.publicAccessToken!,
        publicUrl: credentials.publicUrl,
        securityCode: credentials.securityCode,
        phone: credentials.phone,
        accessJwt: await this.access.issueSession(order),
      },
    };
  }
}

/** "Link xem đơn" — customer opens /order/<token> with phone + security code, no login. */
@Controller('orders/public')
export class PublicOrderAccessController {
  constructor(private readonly service: OrderPublicAccessService) {}

  /** "Tra cứu đơn hàng" without the link: phone + security code, or phone + delivery street. */
  @Post('lookup')
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  lookup(@Body() dto: PublicOrderLookupDto) {
    return this.service.lookup(dto.phone, dto.securityCode, dto.street);
  }

  /** Bare minimum for the unlock screen (order code + masked phone). */
  @Get(':token/meta')
  getMeta(@Param('token') token: string) {
    return this.service.getMeta(token);
  }

  /** Phone + security code (or + delivery street, "Quên mã bảo mật") → short-lived access JWT.
   * Rate-limited + temporary lock. */
  @Post(':token/verify')
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Param('token') token: string, @Body() dto: PublicOrderVerifyDto) {
    return this.service.verify(token, dto.phone, dto.securityCode, dto.street);
  }

  /** VietQR bank-transfer instructions of the order (guest checkout). */
  @Get(':token/payment')
  getPayment(@Param('token') token: string, @Headers('x-order-access') accessJwt?: string) {
    return this.service.getPayment(token, accessJwt);
  }

  /** "Tôi đã chuyển khoản" — customer claim only, the shop confirms. */
  @Post(':token/payment/report')
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reportPayment(
    @Param('token') token: string,
    @Body() dto: ReportPaymentDto,
    @Headers('x-order-access') accessJwt?: string,
  ) {
    return this.service.reportPayment(token, accessJwt, dto?.accountType);
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
