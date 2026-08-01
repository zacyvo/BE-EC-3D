import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { MarketplaceProduct, MarketplaceProductSchema } from './schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantSchema } from './schemas/marketplace-variant.schema';
import { MarketplaceProductImage, MarketplaceProductImageSchema } from './schemas/marketplace-product-image.schema';
import { ShopeeSyncSession, ShopeeSyncSessionSchema } from './schemas/shopee-sync-session.schema';
import { ShopeeSyncItem, ShopeeSyncItemSchema } from './schemas/shopee-sync-item.schema';
import { ShopeeSyncService } from './shopee-sync.service';
import { ShopeeSyncConfigService } from './shopee-sync.config';
import { AdminIntegrationsShopeeController } from './shopee-sync.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MarketplaceProduct.name, schema: MarketplaceProductSchema },
      { name: MarketplaceVariant.name, schema: MarketplaceVariantSchema },
      { name: MarketplaceProductImage.name, schema: MarketplaceProductImageSchema },
      { name: ShopeeSyncSession.name, schema: ShopeeSyncSessionSchema },
      { name: ShopeeSyncItem.name, schema: ShopeeSyncItemSchema },
    ]),
    AuditModule,
  ],
  controllers: [AdminIntegrationsShopeeController],
  providers: [ShopeeSyncService, ShopeeSyncConfigService],
})
export class ShopeeSyncModule {}
