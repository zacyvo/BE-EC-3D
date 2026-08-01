import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { MarketplaceProduct, MarketplaceProductSchema } from '../schemas/marketplace-product.schema';
import { MarketplaceVariant, MarketplaceVariantSchema } from '../schemas/marketplace-variant.schema';
import { MarketplaceProductImage, MarketplaceProductImageSchema } from '../schemas/marketplace-product-image.schema';
import { ShopeeSyncSession, ShopeeSyncSessionSchema } from '../schemas/shopee-sync-session.schema';
import { ShopeeSyncItem, ShopeeSyncItemSchema } from '../schemas/shopee-sync-item.schema';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d';

/**
 * This repo has no versioned migration runner (no migrate-mongo/umzug — confirmed
 * by grepping the codebase). Every existing module relies on Mongoose creating
 * indexes straight from its `@Schema()`/`.index()` definitions at connection time
 * (`autoIndex`, on by default). This script does the same thing explicitly and
 * idempotently via `Model.syncIndexes()`, so it can be run as a one-off "migration"
 * step in CI/deploy instead of only relying on the app's first boot — same
 * bootstrap style as `src/seed/seed.ts` (plain `mongoose.connect`, no Nest DI).
 */
async function migrate() {
  console.log('🔧 Ensuring Shopee sync collection indexes...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const models = [
    mongoose.model(MarketplaceProduct.name, MarketplaceProductSchema),
    mongoose.model(MarketplaceVariant.name, MarketplaceVariantSchema),
    mongoose.model(MarketplaceProductImage.name, MarketplaceProductImageSchema),
    mongoose.model(ShopeeSyncSession.name, ShopeeSyncSessionSchema),
    mongoose.model(ShopeeSyncItem.name, ShopeeSyncItemSchema),
  ];

  for (const model of models) {
    await model.syncIndexes();
    console.log(`  ✓ ${model.collection.collectionName}`);
  }

  console.log('✅ Done — safe to re-run any time (idempotent).');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
