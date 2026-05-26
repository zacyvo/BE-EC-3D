import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { CategoriesService, CreateCategoryDto, AdminListQuery } from './categories.service';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get() findAll() { return this.categoriesService.findAll(true); }
}

@Controller('admin/categories')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(@Query() query: AdminListQuery) {
    return this.categoriesService.findAllPaginated(query);
  }

  @Post()
  create(@Body() dto: CreateCategoryDto, @CurrentUser() s: { sub: string }) {
    return this.categoriesService.create(dto, s.sub);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CreateCategoryDto>) {
    return this.categoriesService.update(id, dto);
  }

  @Patch(':id/toggle-active')
  toggleActive(@Param('id') id: string) {
    return this.categoriesService.toggleActive(id);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async softDelete(@Param('id') id: string, @CurrentUser() s: { sub: string }) {
    await this.categoriesService.softDelete(id, s.sub);
    return { message: 'Category deleted' };
  }
}
