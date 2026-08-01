import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { ProductsModule } from '../products/products.module';
import { Category, CategorySchema } from '../categories/schemas/category.schema';
import { MarketplaceProduct, MarketplaceProductSchema } from './schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantSchema } from './schemas/marketplace-variant.schema';
import { MarketplaceProductImage, MarketplaceProductImageSchema } from './schemas/marketplace-product-image.schema';
import { ShopeeSyncSession, ShopeeSyncSessionSchema } from './schemas/shopee-sync-session.schema';
import { ShopeeSyncItem, ShopeeSyncItemSchema } from './schemas/shopee-sync-item.schema';
import { ShopeeSyncService } from './shopee-sync.service';
import { ShopeeSyncConfigService } from './shopee-sync.config';
import { ShopeeCatalogPublishService } from './shopee-catalog-publish.service';
import { AdminIntegrationsShopeeController } from './shopee-sync.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MarketplaceProduct.name, schema: MarketplaceProductSchema },
      { name: MarketplaceVariant.name, schema: MarketplaceVariantSchema },
      { name: MarketplaceProductImage.name, schema: MarketplaceProductImageSchema },
      { name: ShopeeSyncSession.name, schema: ShopeeSyncSessionSchema },
      { name: ShopeeSyncItem.name, schema: ShopeeSyncItemSchema },
      { name: Category.name, schema: CategorySchema },
    ]),
    AuditModule,
    ProductsModule,
  ],
  controllers: [AdminIntegrationsShopeeController],
  providers: [ShopeeSyncService, ShopeeSyncConfigService, ShopeeCatalogPublishService],
})
export class ShopeeSyncModule {}
