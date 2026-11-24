import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Banner, BannerSchema } from './schemas/banner.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { BannersService } from './banners.service';
import { AdminBannersController, BannersController } from './banners.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Banner.name, schema: BannerSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    AuditModule,
  ],
  controllers: [BannersController, AdminBannersController],
  providers: [BannersService],
})
export class BannersModule {}
