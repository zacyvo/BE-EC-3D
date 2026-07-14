import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ContractsService } from './contracts.service';
import {
  CreateContractDto,
  PublicUpdateDto,
  PublicVerifyDto,
  RevealCodeDto,
  UpdateContractDto,
  UpdateContractStatusDto,
} from './dto/contract.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ─── Admin ─────────────────────────────────────────────────────────────────────

@Controller('admin/contracts')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminContractsController {
  constructor(private readonly service: ContractsService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  create(@Body() dto: CreateContractDto, @CurrentUser() staff: { sub: string }) {
    return this.service.create(dto, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.service.findAll({ page, limit, status, search });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  /** Xem mã bảo mật — yêu cầu nhập lại mật khẩu tài khoản admin */
  @Post(':id/reveal-code')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  revealCode(
    @Param('id') id: string,
    @Body() dto: RevealCodeDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.revealCode(id, staff.sub, dto.password);
  }

  @Patch(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateContractDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.update(id, dto, staff.sub);
  }

  @Patch(':id/status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  changeStatus(
    @Param('id') id: string,
    @Body() dto: UpdateContractStatusDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.changeStatus(id, dto, staff.sub);
  }

  @Delete(':id')
  @Roles(StaffRole.SUPER_ADMIN)
  async remove(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    await this.service.remove(id, staff.sub);
    return { message: 'Đã xóa hợp đồng' };
  }
}

// ─── Public (khách truy cập qua link bảo mật) ─────────────────────────────────

@Controller('contracts/public')
export class PublicContractsController {
  constructor(private readonly service: ContractsService) {}

  /** Thông tin tối thiểu cho màn hình nhập mã (không cần xác thực) */
  @Get(':token/meta')
  getMeta(@Param('token') token: string) {
    return this.service.getPublicMeta(token);
  }

  /** Xác thực SĐT + mã bảo mật — chống dò mã bằng rate-limit + khoá tạm */
  @Post(':token/verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Param('token') token: string, @Body() dto: PublicVerifyDto) {
    return this.service.verifyAccess(token, dto);
  }

  @Get(':token')
  getContract(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt?: string,
  ) {
    return this.service.getPublicContract(token, accessJwt);
  }

  /** Khách điền thông tin Bên A (chỉ khi trạng thái Mới tạo) */
  @Patch(':token/party-a')
  updatePartyA(
    @Param('token') token: string,
    @Body() dto: PublicUpdateDto,
    @Headers('x-contract-access') accessJwt?: string,
  ) {
    return this.service.publicUpdate(token, accessJwt, dto);
  }

  /** Khách xác nhận gửi yêu cầu — chuyển sang trạng thái Review */
  @Post(':token/submit')
  submit(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt?: string,
  ) {
    return this.service.publicSubmit(token, accessJwt);
  }
}
