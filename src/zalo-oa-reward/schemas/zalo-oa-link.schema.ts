import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { RecipientResolution, RewardPhoneSource } from '../zalo-oa-reward.constants';

export type ZaloOaLinkDocument = ZaloOaLink & Document;

/**
 * OA UID → Luxe Glow user, for PROMOTIONAL purposes only. It never authenticates anyone,
 * never changes the user's credentials/phone, and is never overwritten: the first
 * association of a UID wins (unique {oaId, oaUid}).
 */
@Schema({ timestamps: true, collection: 'zalo_oa_links' })
export class ZaloOaLink {
  _id: Types.ObjectId;

  @Prop({ required: true }) oaId: string;
  @Prop({ required: true }) oaUid: string;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) userId: Types.ObjectId;
  @Prop({ required: true, enum: Object.values(RecipientResolution) }) resolution: RecipientResolution;

  /** Promotional phone metadata (national format). Always unverified — no OTP exists. */
  @Prop() phone?: string;
  @Prop({ required: true, enum: Object.values(RewardPhoneSource) }) phoneSource: RewardPhoneSource;
  @Prop({ default: false }) phoneVerified: boolean;

  @Prop({ type: Types.ObjectId, ref: 'ZaloOaRewardSession' }) sessionId?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const ZaloOaLinkSchema = SchemaFactory.createForClass(ZaloOaLink);
ZaloOaLinkSchema.index({ oaId: 1, oaUid: 1 }, { unique: true });
ZaloOaLinkSchema.index({ userId: 1 });
