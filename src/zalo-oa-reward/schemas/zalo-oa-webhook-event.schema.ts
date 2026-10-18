import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZaloOaWebhookEventDocument = ZaloOaWebhookEvent & Document;

/** Dedup ledger for OA webhook deliveries. Zalo retries a failed delivery with identical
 * content (+ a `num_retry` header), so sha256(raw body) identifies a delivery. Rows expire
 * after 7 days (TTL). Stores no message text and no phone. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'zalo_oa_webhook_events' })
export class ZaloOaWebhookEvent {
  _id: Types.ObjectId;

  @Prop({ required: true }) eventKey: string;
  @Prop({ required: true }) eventName: string;
  @Prop() oaUid?: string;
  @Prop() providerTimestamp?: Date;
  /** APPLIED | IGNORED_EVENT | IGNORED_STALE */
  @Prop({ required: true }) outcome: string;

  createdAt: Date;
}

export const ZaloOaWebhookEventSchema = SchemaFactory.createForClass(ZaloOaWebhookEvent);
ZaloOaWebhookEventSchema.index({ eventKey: 1 }, { unique: true });
ZaloOaWebhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
