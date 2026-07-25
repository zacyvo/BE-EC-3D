import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { EInvoiceService, DownloadFormat } from './einvoice.service';
import {
  CancelEInvoiceDto,
  CreateEInvoiceDto,
  RevealKeyDto,
  VerifyEInvoiceDto,
} from './dto/einvoice.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

const CONTENT_TYPES: Record<DownloadFormat, string> = {
  pdf: 'application/pdf',
  'pdf-origin': 'application/pdf',
  'pdf-archive': 'application/pdf',
  xml: 'application/xml',
};

function parseFormat(format?: string): DownloadFormat {
  if (format === 'xml' || format === 'pdf-origin' || format === 'pdf-archive') return format;
  return 'pdf';
}

// ─── Admin ─────────────────────────────────────────────────────────────────────

@Controller('admin/einvoices')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminEInvoiceController {
  constructor(private readonly service: EInvoiceService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  create(@Body() dto: CreateEInvoiceDto, @CurrentUser() staff: { sub: string }) {
    return this.service.create(dto, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') localStatus?: string,
    @Query('search') search?: string,
    @Query('orderId') orderId?: string,
    @Query('contractId') contractId?: string,
    @Query('invoiceKind') invoiceKind?: string,
  ) {
    return this.service.findAll({ page, limit, localStatus, search, orderId, contractId, invoiceKind });
  }

  @Get(':id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  /** Xem khoá mở hoá đơn — yêu cầu nhập lại mật khẩu tài khoản admin */
  @Post(':id/reveal-key')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  revealKey(
    @Param('id') id: string,
    @Body() dto: RevealKeyDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.revealKey(id, staff.sub, dto.password);
  }

  @Post(':id/cancel')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelEInvoiceDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.cancel(id, dto, staff.sub);
  }

  @Post(':id/sync-status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  syncStatus(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.syncStatus(id, staff.sub);
  }

  @Get(':id/download')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async download(
    @Param('id') id: string,
    @Query('format') formatQuery: string | undefined,
    @Res() res: Response,
  ) {
    const format = parseFormat(formatQuery);
    const { buffer, filename } = await this.service.downloadAdmin(id, format);
    res.set({
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }
}

// ─── Public (khách truy cập qua link + khoá mở hoá đơn) ─────────────────────────

@Controller('einvoices/public')
export class PublicEInvoiceController {
  constructor(private readonly service: EInvoiceService) {}

  /** Thông tin tối thiểu cho màn hình nhập khoá (không cần xác thực, không lộ dữ liệu khách hàng) */
  @Get(':token/meta')
  getMeta(@Param('token') token: string) {
    return this.service.getPublicMeta(token);
  }

  /** Xác thực khoá mở hoá đơn — chống dò khoá bằng rate-limit + khoá tạm */
  @Post(':token/verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Param('token') token: string, @Body() dto: VerifyEInvoiceDto) {
    return this.service.verifyAccess(token, dto);
  }

  @Get(':token')
  getInvoice(
    @Param('token') token: string,
    @Headers('x-einvoice-access') accessJwt?: string,
  ) {
    return this.service.getPublicInvoice(token, accessJwt);
  }

  @Get(':token/download')
  async download(
    @Param('token') token: string,
    @Query('format') formatQuery: string | undefined,
    @Headers('x-einvoice-access') accessJwt: string | undefined,
    @Res() res: Response,
  ) {
    const format = parseFormat(formatQuery);
    const { buffer, filename } = await this.service.downloadPublic(token, accessJwt, format);
    res.set({
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }
}
