import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private readonly configService: ConfigService) {
    const cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');

    if (!cloudName || !apiKey || !apiSecret) {
      this.logger.error('Cloudinary credentials are missing. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env');
    } else {
      this.logger.log(`Cloudinary configured with cloud_name: ${cloudName}`);
    }

    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  }

  async uploadMultiple(files: Express.Multer.File[]): Promise<string[]> {
    const results = await Promise.all(files.map((file) => this.uploadOne(file)));
    return results;
  }

  async uploadCustomOrderImages(files: Express.Multer.File[]): Promise<string[]> {
    const results = await Promise.all(
      files.map((file) => this.uploadOne(file, 'web-ec-3d/custom-orders')),
    );
    return results;
  }

  private async uploadOne(file: Express.Multer.File, folder = 'web-ec-3d/products'): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            this.logger.error('Cloudinary upload error', error);
            reject(new InternalServerErrorException(
              error?.message ? `Image upload failed: ${error.message}` : 'Image upload failed',
            ));
          } else {
            resolve(result.secure_url);
          }
        },
      );
      uploadStream.end(file.buffer);
    });
  }

  async deleteByUrl(url: string): Promise<void> {
    const publicId = this.extractPublicId(url);
    if (publicId) {
      await cloudinary.uploader.destroy(publicId);
    }
  }

  private extractPublicId(url: string): string | null {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\./);
    return match ? match[1] : null;
  }
}
