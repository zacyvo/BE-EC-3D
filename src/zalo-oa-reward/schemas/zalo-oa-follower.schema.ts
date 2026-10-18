import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZaloOaFollowerDocument = ZaloOaFollower & Document;

/**
 * app-scoped Zalo user id → OA UID, written ONLY from signature-verified OA follow/unfollow
 * webhooks (which carry both `follower.id` and `user_id_by_app`). This is the trusted
 * bridge between a verified Zalo login and the OA UID; nothing here is client-supplied.
 */
@Schema({ timestamps: true, collection: 'zalo_oa_followers' })
export class ZaloOaFollower {
  _id: Types.ObjectId;

  @Prop({ required: true }) oaId: string;
  @Prop({ required: true }) appId: string;
  @Prop({ required: true }) userIdByApp: string;
  @Prop({ required: true }) oaUid: string;
  @Prop({ required: true }) isFollower: boolean;
  /** follow source reported by Zalo (oa_profile / message_invite / social_plugin / …). */
  @Prop() lastSource?: string;
  /** Provider timestamp (ms) of the latest applied event — older deliveries are ignored. */
  @Prop({ required: true }) lastEventAt: Date;
  @Prop() followedAt?: Date;
  @Prop() unfollowedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZaloOaFollowerSchema = SchemaFactory.createForClass(ZaloOaFollower);
ZaloOaFollowerSchema.index({ oaId: 1, appId: 1, userIdByApp: 1 }, { unique: true });
ZaloOaFollowerSchema.index({ oaId: 1, oaUid: 1 });
