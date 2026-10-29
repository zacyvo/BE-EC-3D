import { Body, Controller, Delete, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtStaffGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, StaffRole } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { OpenApiManualProductSyncDto, OpenApiOrderSyncDto, OpenApiProductSyncDto } from '../dto/open-api-sync.dto';
import { ShopeeOpenApiAuthService } from './shopee-open-api-auth.service';
import { ShopeeOpenApiProductSyncService } from './shopee-open-api-product-sync.service';
import { ShopeeOpenApiOrderSyncService } from './shopee-open-api-order-sync.service';

type StaffPrincipal = { sub: string; role: StaffRole };

const STAFF_READ_ROLES = [StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER];
const STAFF_WRITE_ROLES = [StaffRole.SUPER_ADMIN, StaffRole.ADMIN];

/**
 * Shopee Open Platform v2. Roles mirror the existing flows: product sync = SUPER_ADMIN/ADMIN
 * (like the extension flow, preview/commit stay on AdminIntegrationsShopeeController);
 * order sync = SUPER_ADMIN (creates orders on customers' behalf, like the Excel import);
 * connecting/disconnecting the shop = SUPER_ADMIN.
 */
@Controller('admin/integrations/shopee/open-api')
@UseGuards(JwtStaffGuard, RolesGuard)
export class ShopeeOpenApiAdminController {
  constructor(
    private readonly auth: ShopeeOpenApiAuthService,
    private readonly productSync: ShopeeOpenApiProductSyncService,
    private readonly orderSync: ShopeeOpenApiOrderSyncService,
  ) {}

  @Get('status')
  @Roles(...STAFF_READ_ROLES, StaffRole.SHOPEE_REVIEWER)
  status() {
    return this.auth.statusView();
  }

  @Post('auth-url')
  @Roles(StaffRole.SUPER_ADMIN)
  authUrl(@CurrentUser() staff: StaffPrincipal) {
    return this.auth.createAuthUrl(staff.sub);
  }

  @Delete('connection')
  @Roles(StaffRole.SUPER_ADMIN)
  disconnect(@CurrentUser() staff: StaffPrincipal) {
    return this.auth.disconnect(staff.sub);
  }

  @Post('product-sync')
  @Roles(...STAFF_WRITE_ROLES)
  syncProducts(@Body() dto: OpenApiProductSyncDto, @CurrentUser() staff: StaffPrincipal) {
    return this.productSync.startFullSync(staff.sub, staff.role === StaffRole.SUPER_ADMIN, !!dto.forceFullSync);
  }

  @Post('product-sync/manual')
  @Roles(...STAFF_WRITE_ROLES)
  syncProductsManual(@Body() dto: OpenApiManualProductSyncDto, @CurrentUser() staff: StaffPrincipal) {
    return this.productSync.startManualSync(staff.sub, dto.productIds);
  }

  @Post('order-sync')
  @Roles(StaffRole.SUPER_ADMIN)
  syncOrders(@Body() dto: OpenApiOrderSyncDto, @CurrentUser() staff: StaffPrincipal) {
    return this.orderSync.startManualSync(staff.sub, dto);
  }
}

/** Public: Shopee redirects the seller's browser here after "Uỷ quyền" (SHOPEE_REDIRECT_URL).
 * Only accepts a single-use `state` minted by POST auth-url — see ShopeeOpenApiAuthService. */
@Controller('integrations/shopee/open-api')
@UseGuards(ThrottlerGuard)
export class ShopeeOpenApiCallbackController {
  constructor(private readonly auth: ShopeeOpenApiAuthService) {}

  @Get('callback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async callback(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { redirectUrl } = await this.auth.handleCallback({ code: query.code, shop_id: query.shop_id, state: query.state });
    // The URL carried a single-use code: never cache it, never leak it via Referer.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, redirectUrl);
  }
}
