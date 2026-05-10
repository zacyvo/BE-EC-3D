import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  Delete,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength, Length } from 'class-validator';

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsDateString() dob?: string;
}

class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(6) newPassword: string;
}

class ConfirmDeleteAccountDto {
  @IsString() @Length(6, 6) code: string;
}

class AddAddressDto {
  @IsString() street: string;
  @IsString() ward: string;
  @IsOptional() @IsString() district?: string;
  @IsString() city: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateAddressDto {
  @IsOptional() @IsString() street?: string;
  @IsOptional() @IsString() ward?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() user: { sub: string }) {
    return this.usersService.findById(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateMe(
    @CurrentUser() user: { sub: string },
    @Body() dto: UpdateProfileDto,
  ) {
    const data: { name?: string; dob?: Date } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.dob !== undefined) data.dob = new Date(dto.dob);
    return this.usersService.updateProfile(user.sub, data);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('me/change-password')
  async changePassword(
    @CurrentUser() user: { sub: string },
    @Body() dto: ChangePasswordDto,
  ) {
    await this.usersService.changePassword(user.sub, dto.currentPassword, dto.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('me')
  async deleteSelf(@CurrentUser() user: { sub: string }) {
    await this.usersService.deleteSelf(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('me/delete-account/request')
  async requestDeleteAccount(@CurrentUser() user: { sub: string }) {
    await this.usersService.requestDeleteAccountCode(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('me/delete-account/confirm')
  async confirmDeleteAccount(
    @CurrentUser() user: { sub: string },
    @Body() dto: ConfirmDeleteAccountDto,
  ) {
    await this.usersService.confirmDeleteAccount(user.sub, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('me/addresses')
  async addAddress(
    @CurrentUser() user: { sub: string },
    @Body() dto: AddAddressDto,
  ) {
    return this.usersService.addAddress(user.sub, {
      ...dto,
      isDefault: dto.isDefault ?? true,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/addresses/:index')
  async updateAddress(
    @CurrentUser() user: { sub: string },
    @Param('index') index: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.usersService.updateAddress(user.sub, parseInt(index, 10), dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me/addresses/:index')
  async removeAddress(
    @CurrentUser() user: { sub: string },
    @Param('index') index: string,
  ) {
    return this.usersService.removeAddress(user.sub, parseInt(index, 10));
  }
}

@Controller('admin/users')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.usersService.findAll({ page, limit, search });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() staff: { sub: string },
  ) {
    await this.usersService.softDelete(id, staff.sub);
    return { message: 'User deleted successfully' };
  }

  @Patch(':id/block')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  async toggleBlock(
    @Param('id') id: string,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.usersService.toggleBlock(id, staff.sub);
  }
}
