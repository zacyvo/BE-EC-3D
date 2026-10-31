import {
  Controller, Post, UseInterceptors, UploadedFiles,
  UseGuards, BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { JwtAuthGuard, JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RETURN_MAX_IMAGES } from '../order-returns/order-return.constants';

@Controller('upload')
@UseGuards(JwtStaffGuard)
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('images')
  @UseInterceptors(
    FilesInterceptor('images', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp|gif)$/)) {
          return cb(new BadRequestException('Only image files allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadImages(
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    const urls = await this.uploadService.uploadMultiple(files);
    return { urls };
  }
}

/** Endpoint used by regular users to upload images for custom-order requests */
@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UserUploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('custom-order-images')
  @UseInterceptors(
    FilesInterceptor('files', 3, {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp|gif)$/)) {
          return cb(new BadRequestException('Only image files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadCustomOrderImages(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    if (files.length > 3) {
      throw new BadRequestException('Maximum 3 images allowed');
    }
    const urls = await this.uploadService.uploadCustomOrderImages(files);
    return { urls };
  }

  /** Evidence photos for a return/refund request (see order-returns). */
  @Post('return-images')
  @UseInterceptors(
    FilesInterceptor('files', RETURN_MAX_IMAGES, {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.match(/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/)) {
          return cb(new BadRequestException('Only image files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadReturnImages(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    const urls = await this.uploadService.uploadReturnImages(files);
    return { urls };
  }
}
