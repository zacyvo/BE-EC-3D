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
  Matches,
  IsOptional,
} from 'class-validator';
import { ValidateIf } from 'class-validator';

class CreateStaffDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(32) password: string;
  @IsString() @MinLength(2) name: string;
  @IsEnum(StaffRole) role: StaffRole;
}

class UpdateStaffDto {
  @IsOptional()
  @IsString() @MinLength(2) @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @ValidateIf((o) => o.name === undefined && o.role === undefined)
  @IsString({ message: 'At least one field must be provided' })
  _dummy?: never;
}

class UpdateProfileDto {
  @IsString() @MinLength(2) @MaxLength(64) name: string;

  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/, {
    message: 'Số điện thoại không hợp lệ (VD: 0912345678)',
  })
  phone?: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(1) currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Mật khẩu cần có chữ hoa, chữ thường và số',
  })
  newPassword: string;
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

  @Patch(':id')
  async updateById(
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staffService.updateById(id, { name: dto.name, role: dto.role });
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

  // ─── Self-service (any authenticated staff) ─────────────────────────────────

  @Get('me')
  @Roles() // override SUPER_ADMIN restriction
  async getMe(@CurrentUser() staff: { sub: string }) {
    return this.staffService.getMe(staff.sub);
  }

  @Patch('me/profile')
  @Roles()
  async updateProfile(
    @CurrentUser() staff: { sub: string },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.staffService.updateProfile(staff.sub, { name: dto.name, phone: dto.phone });
  }

  @Patch('me/password')
  @Roles()
  async changePassword(
    @CurrentUser() staff: { sub: string },
    @Body() dto: ChangePasswordDto,
  ) {
    await this.staffService.changePassword(staff.sub, dto.currentPassword, dto.newPassword);
    return { message: 'Mật khẩu đã được cập nhật' };
  }
}
