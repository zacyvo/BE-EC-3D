import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ContractAddendaService } from './contract-addenda.service';
import {
  CancelAddendumDto,
  CreateAddendumDto,
  RejectSignatureDto,
  SignContractDto,
  SubmitSimpleSignatureDto,
  UpdateAddendumDto,
} from './dto/contract.dto';
import { multipartValidation, P12_UPLOAD_OPTIONS, PDF_UPLOAD_OPTIONS } from './contracts.controller';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

function sendPdf(res: Response, file: { buffer: Buffer; filename: string }, disposition: 'inline' | 'attachment') {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="${encodeURIComponent(file.filename)}"`,
    'Content-Length': String(file.buffer.length),
  });
  res.send(file.buffer);
}

// ─── Admin ─────────────────────────────────────────────────────────────────────

/** Phụ lục hợp đồng — chỉ lập cho hợp đồng đã chốt (FINAL), xem ContractAddendaService */
@Controller('admin/contracts/:id/addenda')
@UseGuards(JwtStaffGuard, RolesGuard)
export class AdminContractAddendaController {
  constructor(private readonly service: ContractAddendaService) {}

  @Post()
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  create(@Param('id') id: string, @Body() dto: CreateAddendumDto, @CurrentUser() staff: { sub: string }) {
    return this.service.create(id, dto, staff.sub);
  }

  @Patch(':addendumId')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  update(
    @Param('id') id: string,
    @Param('addendumId') addendumId: string,
    @Body() dto: UpdateAddendumDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.update(id, addendumId, dto, staff.sub);
  }

  @Delete(':addendumId')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  remove(@Param('id') id: string, @Param('addendumId') addendumId: string, @CurrentUser() staff: { sub: string }) {
    return this.service.remove(id, addendumId, staff.sub);
  }

  @Post(':addendumId/finalize')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  finalize(@Param('id') id: string, @Param('addendumId') addendumId: string, @CurrentUser() staff: { sub: string }) {
    return this.service.finalize(id, addendumId, staff.sub);
  }

  @Post(':addendumId/cancel')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  cancel(
    @Param('id') id: string,
    @Param('addendumId') addendumId: string,
    @Body() dto: CancelAddendumDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.cancel(id, addendumId, dto, staff.sub);
  }

  /** PDF xem trước (bản nháp dựng từ dữ liệu hiện tại; đã chốt trả bản chính tắc) */
  @Get(':addendumId/document/preview')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async preview(@Param('id') id: string, @Param('addendumId') addendumId: string, @Res() res: Response) {
    sendPdf(res, await this.service.previewPdf(id, addendumId), 'inline');
  }

  @Post(':addendumId/document/generate')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  generate(@Param('id') id: string, @Param('addendumId') addendumId: string, @CurrentUser() staff: { sub: string }) {
    return this.service.generateDocument(id, addendumId, staff.sub);
  }

  @Get(':addendumId/document/unsigned')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async downloadUnsigned(@Param('id') id: string, @Param('addendumId') addendumId: string, @Res() res: Response) {
    sendPdf(res, await this.service.getUnsignedPdf(id, addendumId), 'attachment');
  }

  /** Xuất PDF phụ lục kèm chữ ký số (bản mới nhất: Bên A PKI > Bên B) */
  @Get(':addendumId/document/signed')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER)
  async downloadSigned(@Param('id') id: string, @Param('addendumId') addendumId: string, @Res() res: Response) {
    sendPdf(res, await this.service.getSignedPdf(id, addendumId), 'attachment');
  }

  @Post(':addendumId/document/party-b-signed')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_OPTIONS))
  uploadPartyBSigned(
    @Param('id') id: string,
    @Param('addendumId') addendumId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() staff: { sub: string },
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF đã ký');
    return this.service.uploadPartyBSigned(id, addendumId, file.buffer, staff.sub);
  }

  /** Bên B ký số trên hệ thống — multipart giống POST /admin/contracts/:id/document/sign */
  @Post(':addendumId/document/sign')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('certificate', P12_UPLOAD_OPTIONS))
  async signPartyB(
    @Param('id') id: string,
    @Param('addendumId') addendumId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentUser() staff: { sub: string },
  ) {
    const dto: SignContractDto = await multipartValidation.transform(body ?? {}, {
      type: 'body',
      metatype: SignContractDto,
    });
    return this.service.signPartyBInSystem(id, addendumId, dto, file?.buffer, staff.sub);
  }

  @Post(':addendumId/document/party-a-signed/reject')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  rejectPartyA(
    @Param('id') id: string,
    @Param('addendumId') addendumId: string,
    @Body() dto: RejectSignatureDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.service.rejectPartyASignature(id, addendumId, dto, staff.sub);
  }
}

// ─── Public (khách qua link bảo mật của hợp đồng) ─────────────────────────────

@Controller('contracts/public/:token/addenda/:addendumId/document')
export class PublicContractAddendaController {
  constructor(private readonly service: ContractAddendaService) {}

  @Get('view')
  async view(
    @Param('token') token: string,
    @Param('addendumId') addendumId: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Res() res: Response,
  ) {
    sendPdf(res, await this.service.getPublicView(token, accessJwt, addendumId), 'inline');
  }

  @Get('to-sign')
  async toSign(
    @Param('token') token: string,
    @Param('addendumId') addendumId: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Res() res: Response,
  ) {
    sendPdf(res, await this.service.getDocumentToSign(token, accessJwt, addendumId), 'attachment');
  }

  @Post('party-a-signed')
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_OPTIONS))
  uploadPartyASigned(
    @Param('token') token: string,
    @Param('addendumId') addendumId: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file PDF đã ký');
    return this.service.uploadPartyASigned(token, accessJwt, addendumId, file.buffer);
  }

  @Post('party-a-simple-signature')
  submitSimpleSignature(
    @Param('token') token: string,
    @Param('addendumId') addendumId: string,
    @Headers('x-contract-access') accessJwt: string | undefined,
    @Body() dto: SubmitSimpleSignatureDto,
    @Req() req: Request,
  ) {
    return this.service.submitPartyASimpleSignature(
      token,
      accessJwt,
      addendumId,
      dto,
      req.ip ?? '',
      req.headers['user-agent'] ?? '',
    );
  }
}
