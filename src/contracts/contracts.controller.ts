import {
  BadRequestException,
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
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ContractsService } from './contracts.service';
import {
  CreateContractDto,
  ImportContractDto,
  PublicUpdateDto,
  PublicVerifyDto,
  RejectSignatureDto,
  RevealCodeDto,
  SubmitSimpleSignatureDto,
  UpdateContractDto,
  UpdateContractStatusDto,
  UpdateImportedContractDto,
} from './dto/contract.dto';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/** Upload PDF (file ký số / file hợp đồng import) — nội dung còn được kiểm tra lại ở service */
const PDF_UPLOAD_OPTIONS: MulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    if (!['application/pdf', 'application/x-pdf'].includes(file.mimetype)) {
      return cb(new BadRequestException('Chỉ chấp nhận file PDF'), false);
    }
    cb(null, true);
  },
};

/** Cùng cấu hình với ValidationPipe toàn cục (main.ts) — dùng cho field JSON trong multipart */
const multipartValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

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

  /**
   * Import hợp đồng soạn ngoài hệ thống từ file PDF. Multipart: `file` (PDF ≤ 20MB) +
   * `data` (chuỗi JSON theo ImportContractDto).
   */
  @Post('import')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_OPTIONS))
  async importContract(
    @UploadedFile() file: Express.Multer.File,
    @Body('data') data: string | undefined,
    @CurrentUser() staff: { sub: string },
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF hợp đồng');
    let plain: unknown;
    try {
      plain = JSON.parse(data ?? '');
    } catch {
      throw new BadRequestException('Dữ liệu hợp đồng không hợp lệ');
    }
    const dto: ImportContractDto = await multipartValidation.transform(plain, {
      type: 'body',
      metatype: ImportContractDto,
    });
    return this.service.importContract(dto, file, staff.sub);
  }

  @Get()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('source') source?: string,
  ) {
    return this.service.findAll({ page, limit, status, search, source });
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

  /** Sửa thông tin hợp đồng import (DRAFT: mọi trường; FINAL: ghi chú + xác nhận đã ký ngoài hệ thống) */
  @Patch(':id/import')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  updateImported(
    @Param('id') id: string,
    @Body() dto: UpdateImportedContractDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.updateImported(id, dto, staff.sub);
  }

  /** Thay file PDF hợp đồng import — chỉ khi còn DRAFT */
  @Post(':id/import/file')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_OPTIONS))
  replaceImportedFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() staff: { sub: string },
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF hợp đồng');
    return this.service.replaceImportedFile(id, file, staff.sub);
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

  // ─── Tài liệu & Ký số ────────────────────────────────────────────────────────

  @Get(':id/document/status')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  getDocumentStatus(@Param('id') id: string) {
    return this.service.getDocumentStatus(id);
  }

  @Post(':id/document/generate')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  generateDocument(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.generateDocument(id, staff.sub);
  }

  @Get(':id/document/unsigned')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async downloadUnsigned(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.getUnsignedPdfBuffer(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  @Get(':id/document/party-b-signed')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async downloadPartyBSigned(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.service.getPartyBSignedPdfBuffer(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  @Post(':id/document/party-b-signed')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', PDF_UPLOAD_OPTIONS),
  )
  uploadPartyBSigned(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() staff: { sub: string },
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF đã ký');
    return this.service.uploadPartyBSigned(id, file.buffer, staff.sub);
  }

  @Post(':id/document/party-a-signed/reject')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  rejectPartyASignature(
    @Param('id') id: string,
    @Body() dto: RejectSignatureDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.rejectPartyASignature(id, dto, staff.sub);
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

  // ─── Tài liệu & Ký số (Bên A) ─────────────────────────────────────────────────

  @Get(':token/document/status')
  getDocumentStatus(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt?: string,
  ) {
    return this.service.getPublicDocumentStatus(token, accessJwt);
  }

  /** PDF văn bản hợp đồng để xem (dùng cho hợp đồng import) — bản mới nhất đã ký */
  @Get(':token/document/view')
  async viewDocument(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.service.getPublicDocumentView(token, accessJwt);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  /** PDF khách cần tải về để ký chồng lên (đã có sẵn chữ ký Bên B) */
  @Get(':token/document/to-sign')
  async downloadToSign(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.service.getDocumentToSign(token, accessJwt);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  @Post(':token/document/party-a-signed')
  @UseInterceptors(
    FileInterceptor('file', PDF_UPLOAD_OPTIONS),
  )
  uploadPartyASigned(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF đã ký');
    return this.service.uploadPartyASigned(token, accessJwt, file.buffer);
  }

  /** Chữ ký điện tử đơn giản (canvas) — fallback khi khách không có chữ ký số thật */
  @Post(':token/document/party-a-simple-signature')
  submitSimpleSignature(
    @Param('token') token: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Body() dto: SubmitSimpleSignatureDto,
    @Req() req: Request,
  ) {
    return this.service.submitPartyASimpleSignature(
      token,
      accessJwt,
      dto,
      req.ip ?? '',
      req.headers['user-agent'] ?? '',
    );
  }
}
