import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ShopeeOrderSyncService } from './shopee-order-sync.service';
import { ResolveShopeeOrderIssueDto } from './dto/resolve-shopee-order-issue.dto';
import { ShopeeOrderIssueStatus } from './schemas/shopee-order-sync-issue.schema';

const READ_ROLES = [StaffRole.SUPER_ADMIN, StaffRole.ADMIN, StaffRole.CS, StaffRole.SELLER];

/**
 * Excel-based Shopee order sync — distinct upload mechanism from the Chrome
 * Extension product sync (`shopee-sync.controller.ts`), but lives in the same
 * module/route family since it's the "Đơn hàng" side of the same "Đồng bộ Shopee"
 * admin feature. Creating orders on a customer's behalf is SUPER_ADMIN-only,
 * matching `AdminOrdersController.createForUser`'s existing restriction.
 */
@Controller('admin/integrations/shopee/orders')
@UseGuards(JwtStaffGuard, RolesGuard)
export class ShopeeOrderSyncController {
  constructor(private readonly service: ShopeeOrderSyncService) {}

  @Post('import')
  @Roles(StaffRole.SUPER_ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
      fileFilter: (_req, file, cb) => {
        const allowed = [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
        ];
        if (!allowed.includes(file.mimetype)) {
          return cb(new BadRequestException('Chỉ chấp nhận file Excel (.xlsx) xuất từ Shopee'), false);
        }
        cb(null, true);
      },
    }),
  )
  import(@UploadedFile() file: Express.Multer.File, @CurrentUser() staff: { sub: string }) {
    if (!file) throw new BadRequestException('Vui lòng chọn file Excel để tải lên');
    return this.service.importWorkbook(file.buffer, file.originalname, staff.sub);
  }

  @Get('batches')
  @Roles(...READ_ROLES)
  listBatches(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.service.listBatches(page, limit);
  }

  @Get('batches/:id')
  @Roles(...READ_ROLES)
  getBatch(@Param('id') id: string) {
    return this.service.getBatch(id);
  }

  @Get('issues')
  @Roles(...READ_ROLES)
  listIssues(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: ShopeeOrderIssueStatus,
  ) {
    return this.service.listIssues(page, limit, status);
  }

  @Get('issues/:id')
  @Roles(...READ_ROLES)
  getIssue(@Param('id') id: string) {
    return this.service.getIssue(id);
  }

  @Post('issues/:id/resolve')
  @Roles(StaffRole.SUPER_ADMIN)
  resolveIssue(@Param('id') id: string, @Body() dto: ResolveShopeeOrderIssueDto, @CurrentUser() staff: { sub: string }) {
    return this.service.resolveIssue(id, staff.sub, dto.itemMappings);
  }

  @Delete('issues/:id')
  @Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
  dismissIssue(@Param('id') id: string, @CurrentUser() staff: { sub: string }) {
    return this.service.dismissIssue(id, staff.sub);
  }
}
