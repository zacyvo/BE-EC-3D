import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export interface StoredPdf {
  url: string;
  publicId: string;
}

/**
 * Lưu trữ file PDF (chưa ký / đã ký) trên Cloudinary với resource_type 'raw' — khác với
 * upload.service.ts (chỉ dùng cho ảnh, resource_type mặc định 'image' sẽ làm hỏng file PDF).
 * Tái dùng Cloudinary đã cấu hình sẵn thay vì thêm hạ tầng lưu trữ mới.
 */
@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);

  constructor(private readonly configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadPdf(buffer: Buffer, publicId: string): Promise<StoredPdf> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: 'web-ec-3d/contracts-signing',
          public_id: publicId,
          overwrite: true,
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            this.logger.error('Cloudinary raw upload error', error);
            reject(
              new InternalServerErrorException(
                error?.message ? `Tải PDF lên thất bại: ${error.message}` : 'Tải PDF lên thất bại',
              ),
            );
          } else {
            resolve({ url: result.secure_url, publicId: result.public_id });
          }
        },
      );
      uploadStream.end(buffer);
    });
  }

  async downloadPdf(url: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      this.logger.error(`Không thể tải file PDF (${url}): ${(err as Error).message}`);
      throw new ServiceUnavailableException('Không thể tải file PDF đã lưu trữ');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`Tải file PDF thất bại (HTTP ${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async deleteRaw(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    } catch (err) {
      this.logger.warn(`Không thể xoá file raw ${publicId}: ${(err as Error).message}`);
    }
  }
}
