import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { NotificationJob, NotificationJobSchema } from '../../zalo-bot/schemas/notification-job.schema';
import { ZbsCredential, ZbsCredentialSchema } from '../schemas/zbs-credential.schema';
import { ZbsTemplateVerification, ZbsTemplateVerificationSchema } from '../schemas/zbs-template-verification.schema';
import { ZbsCampaign, ZbsCampaignSchema } from '../schemas/zbs-campaign.schema';
import { ZbsCampaignMessage, ZbsCampaignMessageSchema } from '../schemas/zbs-campaign-message.schema';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d';

/**
 * Same approach as src/zalo-bot/migrations/ensure-indexes.ts: additive createIndexes only
 * (never syncIndexes — it could drop indexes). Creates zalo_zbs_credentials (unique key),
 * zalo_zbs_templates (unique templateKey+templateId), the notification_jobs
 * {channel, createdAt} index, and the promotion campaign collections zalo_zbs_campaigns /
 * zalo_zbs_campaign_messages (unique dedupKey — mandatory before sending a campaign). Existing Bot rows/indexes are untouched. Idempotent.
 */
async function migrate() {
  console.log('🔧 Ensuring Zalo ZBS indexes...');
  await mongoose.connect(MONGODB_URI);
  const models = [
    mongoose.model(NotificationJob.name, NotificationJobSchema),
    mongoose.model(ZbsCredential.name, ZbsCredentialSchema),
    mongoose.model(ZbsTemplateVerification.name, ZbsTemplateVerificationSchema),
    mongoose.model(ZbsCampaign.name, ZbsCampaignSchema),
    mongoose.model(ZbsCampaignMessage.name, ZbsCampaignMessageSchema),
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
