import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { NotificationJob, NotificationJobSchema } from '../schemas/notification-job.schema';
import { ZaloBotRecipient, ZaloBotRecipientSchema } from '../schemas/zalo-bot-recipient.schema';
import { Order, OrderSchema } from '../../orders/schemas/order.schema';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d';

/**
 * Same approach as src/shopee-sync/migrations/ensure-indexes.ts: no migration runner in
 * this repo, Mongoose autoIndex builds these on boot anyway; this makes it an explicit,
 * idempotent deploy step. Creates notification_jobs (unique dedupKey), zalo_bot_recipients
 * (unique chatId) and the sparse orders.pendingNotificationEvents index. Uses createIndexes
 * (additive) rather than syncIndexes so it can never drop an existing orders index.
 */
async function migrate() {
  console.log('🔧 Ensuring Zalo Bot notification indexes...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const models = [
    mongoose.model(NotificationJob.name, NotificationJobSchema),
    mongoose.model(ZaloBotRecipient.name, ZaloBotRecipientSchema),
    mongoose.model(Order.name, OrderSchema),
  ];

  for (const model of models) {
    await model.createIndexes();
    console.log(`  ✓ ${model.collection.collectionName}`);
  }

  console.log('✅ Done — safe to re-run any time (idempotent).');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
