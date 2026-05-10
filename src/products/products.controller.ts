import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Public User API ─────────────────────────────────────────────────────────

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit: number,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('minPrice', new DefaultValuePipe(0), ParseIntPipe) minPrice?: number,
    @Query('maxPrice', new DefaultValuePipe(0), ParseIntPipe) maxPrice?: number,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    return this.productsService.findAll({
      page,
      limit,
      category,
      search,
      forAdmin: false,
      minPrice: minPrice || undefined,
      maxPrice: maxPrice || undefined,
      sortBy,
      sortOrder,
    });
  }

  @Get(':slug')
  async findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug, false);
  }
}

// ─── Admin API ────────────────────────────────────────────────────────────────

@Controller('admin/products')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.SELLER)
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    return this.productsService.findAll({ page, limit, category, search, forAdmin: true });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.SELLER)
  async findOne(@Param('id') id: string) {
    return this.productsService.findById(id, true);
  }

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async create(
    @Body() dto: CreateProductDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.productsService.create(dto, staff.sub);
  }

  @Put(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.productsService.update(id, dto, staff.sub);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() staff: { sub: string },
  ) {
    await this.productsService.softDelete(id, staff.sub);
    return { message: 'Product deleted successfully' };
  }
}
