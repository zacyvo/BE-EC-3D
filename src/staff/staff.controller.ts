import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { StaffService } from './staff.service';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  IsEmail,
  IsEnum,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

class CreateStaffDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(32) password: string;
  @IsString() @MinLength(2) name: string;
  @IsEnum(StaffRole) role: StaffRole;
}

@Controller('admin/staff')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.staffService.findAll({ page, limit });
  }

  @Post()
  async create(
    @Body() dto: CreateStaffDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.staffService.create({ ...dto, createdBy: staff.sub });
  }

  @Delete(':id')
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() staff: { sub: string; role: StaffRole },
  ) {
    await this.staffService.softDelete(id, staff.sub, staff.role);
    return { message: 'Staff deleted successfully' };
  }

  @Patch(':id/toggle-active')
  async toggleActive(@Param('id') id: string) {
    return this.staffService.toggleActive(id);
  }
}
