import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { UploadController, UserUploadController } from './upload.controller';

@Module({
  imports: [
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [UploadController, UserUploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
