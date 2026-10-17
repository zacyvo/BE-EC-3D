import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZaloBotRecipientDocument = ZaloBotRecipient & Document;

export enum ZaloBotRecipientStatus {
  /** Seen via webhook — NOT allowed to receive notifications until an admin approves. */
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REVOKED = 'REVOKED',
}

/**
 * A Zalo chat discovered through the Bot webhook. Messaging the bot only ever creates a
 * PENDING row; becoming a notification recipient requires an explicit SUPER_ADMIN
 * approval (owner enrollment). Message contents are never stored.
 */
@Schema({ timestamps: true, collection: 'zalo_bot_recipients' })
export class ZaloBotRecipient {
  _id: Types.ObjectId;

  @Prop({ required: true }) chatId: string;
  @Prop() chatType?: string;
  @Prop() displayName?: string;
  @Prop({ required: true, enum: Object.values(ZaloBotRecipientStatus), default: ZaloBotRecipientStatus.PENDING })
  status: ZaloBotRecipientStatus;

  @Prop({ required: true }) firstSeenAt: Date;
  @Prop({ required: true }) lastSeenAt: Date;

  @Prop() approvedBy?: string;
  @Prop() approvedAt?: Date;
  @Prop() revokedBy?: string;
  @Prop() revokedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZaloBotRecipientSchema = SchemaFactory.createForClass(ZaloBotRecipient);
ZaloBotRecipientSchema.index({ chatId: 1 }, { unique: true });
ZaloBotRecipientSchema.index({ status: 1 });
