import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { ProductsModule } from '../products/products.module';
import { OrdersModule } from '../orders/orders.module';
import { Category, CategorySchema } from '../categories/schemas/category.schema';
import { MarketplaceProduct, MarketplaceProductSchema } from './schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantSchema } from './schemas/marketplace-variant.schema';
import { MarketplaceProductImage, MarketplaceProductImageSchema } from './schemas/marketplace-product-image.schema';
import { ShopeeSyncSession, ShopeeSyncSessionSchema } from './schemas/shopee-sync-session.schema';
import { ShopeeSyncItem, ShopeeSyncItemSchema } from './schemas/shopee-sync-item.schema';
import { ShopeeOrderSyncBatch, ShopeeOrderSyncBatchSchema } from './schemas/shopee-order-sync-batch.schema';
import { ShopeeOrderSyncIssue, ShopeeOrderSyncIssueSchema } from './schemas/shopee-order-sync-issue.schema';
import { ShopeeSyncService } from './shopee-sync.service';
import { ShopeeSyncConfigService } from './shopee-sync.config';
import { ShopeeCatalogPublishService } from './shopee-catalog-publish.service';
import { ShopeeOrderSyncService } from './shopee-order-sync.service';
import { AdminIntegrationsShopeeController } from './shopee-sync.controller';
import { ShopeeOrderSyncController } from './shopee-order-sync.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MarketplaceProduct.name, schema: MarketplaceProductSchema },
      { name: MarketplaceVariant.name, schema: MarketplaceVariantSchema },
      { name: MarketplaceProductImage.name, schema: MarketplaceProductImageSchema },
      { name: ShopeeSyncSession.name, schema: ShopeeSyncSessionSchema },
      { name: ShopeeSyncItem.name, schema: ShopeeSyncItemSchema },
      { name: ShopeeOrderSyncBatch.name, schema: ShopeeOrderSyncBatchSchema },
      { name: ShopeeOrderSyncIssue.name, schema: ShopeeOrderSyncIssueSchema },
      { name: Category.name, schema: CategorySchema },
    ]),
    AuditModule,
    ProductsModule,
    OrdersModule,
  ],
  controllers: [AdminIntegrationsShopeeController, ShopeeOrderSyncController],
  providers: [ShopeeSyncService, ShopeeSyncConfigService, ShopeeCatalogPublishService, ShopeeOrderSyncService],
})
export class ShopeeSyncModule {}
