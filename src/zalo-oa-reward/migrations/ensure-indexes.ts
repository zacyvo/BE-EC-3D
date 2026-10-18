import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { ZaloOaRewardSession, ZaloOaRewardSessionSchema } from '../schemas/zalo-oa-reward-session.schema';
import { ZaloOaFollower, ZaloOaFollowerSchema } from '../schemas/zalo-oa-follower.schema';
import { ZaloOaLink, ZaloOaLinkSchema } from '../schemas/zalo-oa-link.schema';
import { ZaloOaRewardGrant, ZaloOaRewardGrantSchema } from '../schemas/zalo-oa-reward-grant.schema';
import { ZaloOaWebhookEvent, ZaloOaWebhookEventSchema } from '../schemas/zalo-oa-webhook-event.schema';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d';

/**
 * Same approach as the Bot/ZBS migrations: additive createIndexes only (never syncIndexes).
 * Creates the five NEW zalo_oa_* collections' indexes — including the uniqueness constraints
 * that make the reward idempotent (one grant per {promotion, OA UID} and per {promotion,
 * user}; one link per OA UID; one session per order). Touches no existing collection.
 */
async function migrate() {
  console.log('🔧 Ensuring Zalo OA reward indexes...');
  await mongoose.connect(MONGODB_URI);
  const models = [
    mongoose.model(ZaloOaRewardSession.name, ZaloOaRewardSessionSchema),
    mongoose.model(ZaloOaFollower.name, ZaloOaFollowerSchema),
    mongoose.model(ZaloOaLink.name, ZaloOaLinkSchema),
    mongoose.model(ZaloOaRewardGrant.name, ZaloOaRewardGrantSchema),
    mongoose.model(ZaloOaWebhookEvent.name, ZaloOaWebhookEventSchema),
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
