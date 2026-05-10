import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import {
  CreatePromotionDto, UpdatePromotionDto, AssignPromotionDto,
  CreateCouponItemDto, UpdateCouponItemDto,
  ValidateCouponsDto, QueryPromotionsDto,
} from './dto/promotion.dto';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Admin routes (/admin/promotions) ────────────────────────────────────────
@Controller('admin/promotions')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  // Program CRUD
  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  create(@Body() dto: CreatePromotionDto, @CurrentUser() staff: { sub: string }) {
    return this.promotionsService.create(dto, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(@Query() query: QueryPromotionsDto): Promise<any> {
    return this.promotionsService.findAll(query);
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS)
  findOne(@Param('id') id: string) {
    return this.promotionsService.findByIdSafe(id);
  }

  @Patch(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotionsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.promotionsService.remove(id);
  }

  // Assign / unassign users
  @Patch(':id/assign')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  assign(@Param('id') id: string, @Body() dto: AssignPromotionDto) {
    return this.promotionsService.assign(id, dto);
  }

  // Coupon CRUD within a program
  @Post(':id/coupons')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  addCoupon(@Param('id') id: string, @Body() dto: CreateCouponItemDto) {
    return this.promotionsService.addCoupon(id, dto);
  }

  @Patch(':id/coupons/:couponId')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  updateCoupon(
    @Param('id') id: string,
    @Param('couponId') couponId: string,
    @Body() dto: UpdateCouponItemDto,
  ) {
    return this.promotionsService.updateCoupon(id, couponId, dto);
  }

  @Delete(':id/coupons/:couponId')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  removeCoupon(@Param('id') id: string, @Param('couponId') couponId: string) {
    return this.promotionsService.removeCoupon(id, couponId);
  }
}

// ─── User routes (/promotions) ────────────────────────────────────────────────
@Controller('promotions')
@UseGuards(JwtAuthGuard)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  /** Flat list of all coupons accessible by the current user */
  @Get('my-coupons')
  getMyCoupons(@CurrentUser() user: { sub: string }) {
    return this.promotionsService.getMyCoupons(user.sub);
  }

  /** Validate selected coupon codes against an order total */
  @Post('validate')
  validateCoupons(@CurrentUser() user: { sub: string }, @Body() dto: ValidateCouponsDto) {
    return this.promotionsService.validateCoupons(user.sub, dto);
  }
}

