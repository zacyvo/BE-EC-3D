import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { NotificationEventType, NotificationStatus } from '../zalo-bot.constants';

export type NotificationJobDocument = NotificationJob & Document;

@Schema({ _id: false })
export class NotificationAttempt {
  @Prop({ required: true }) at: Date;
  /** ACCEPTED | TRANSIENT | PERMANENT | UNKNOWN | CONFIG | VALIDATION | ... */
  @Prop({ required: true }) outcome: string;
  @Prop() errorCode?: string;
  @Prop() httpStatus?: number;
  @Prop() durationMs?: number;
}

const NotificationAttemptSchema = SchemaFactory.createForClass(NotificationAttempt);

/**
 * One row = one (event, channel, order, recipient) notification — shared by the owner Zalo
 * Bot channel (ZALO_BOT) and the customer ZBS channel (ZALO_ZBS). It is both the durable
 * job (outbox → worker) and the notification history the admin page reads.
 *
 * The message text itself is NOT stored — it is rebuilt from the order at send time, so
 * customer PII lives only in the order. `dedupKey` + its unique index is the durable
 * guarantee against sending the same event twice to the same recipient.
 */
@Schema({ timestamps: true, collection: 'notification_jobs' })
export class NotificationJob {
  _id: Types.ObjectId;

  @Prop({ required: true }) dedupKey: string;
  @Prop({ required: true }) channel: string;
  @Prop({ required: true, enum: Object.values(NotificationEventType) }) eventType: NotificationEventType;
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true }) orderId: Types.ObjectId;
  /** Short display code (e.g. "#ABCD1234") so history is readable without a join. */
  @Prop() orderCode?: string;

  /** Zalo chat_id to send to (or NO_RECIPIENT_PLACEHOLDER). Only exposed masked via the API. */
  @Prop({ required: true }) recipientId: string;
  /** Where the recipient's approval came from: ENV (ZALO_OWNER_CHAT_IDS) or DB (admin-approved). */
  @Prop() recipientSource?: 'ENV' | 'DB';
  @Prop() recipientLabel?: string;

  @Prop({ required: true, enum: Object.values(NotificationStatus), default: NotificationStatus.PENDING })
  status: NotificationStatus;

  @Prop({ default: 0 }) attemptCount: number;
  @Prop({ required: true }) maxAttempts: number;
  @Prop({ default: () => new Date() }) nextAttemptAt: Date;

  /** Lease: a worker owns the job while PROCESSING until this time. */
  @Prop() lockedUntil?: Date;
  @Prop() lockOwner?: string;

  @Prop() providerMessageId?: string;
  @Prop() lastErrorCode?: string;
  @Prop() lastErrorMessage?: string;
  @Prop() lastHttpStatus?: number;

  /** Last 10 attempts, oldest first. */
  @Prop({ type: [NotificationAttemptSchema], default: [] }) attempts: NotificationAttempt[];

  // ── ZBS (channel ZALO_ZBS) only — absent on Zalo Bot rows ──
  /** Logical template key, e.g. ORDER_CONFIRMATION. */
  @Prop() templateKey?: string;
  /** Zalo template_id used for the send (copied from config at send time). */
  @Prop() templateId?: string;
  /** tracking_id sent to ZBS — stable per notification, for reconciliation with Zalo. */
  @Prop() trackingId?: string;
  /** RETRYABLE | NON_RETRYABLE | AUTHENTICATION_REQUIRED | CONFIGURATION_REQUIRED | UNKNOWN_OUTCOME */
  @Prop() errorClass?: string;
  @Prop() providerSentTime?: Date;
  @Prop() providerSendingMode?: string;
  @Prop({ type: Object }) providerQuota?: { dailyQuota?: number; remainingQuota?: number };
  /** Last answer of the ZBS message-status API (-1 / 0 / 1) and when we asked. */
  @Prop() providerDeliveryStatus?: number;
  @Prop() deliveryCheckedAt?: Date;
  /** Only set from provider delivery evidence (status API), never inferred. */
  @Prop() deliveredAt?: Date;

  @Prop() acceptedAt?: Date;
  /** When the job reached a terminal-or-parked state (ACCEPTED/FAILED/UNKNOWN/SKIPPED). */
  @Prop() processedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const NotificationJobSchema = SchemaFactory.createForClass(NotificationJob);
NotificationJobSchema.index({ dedupKey: 1 }, { unique: true });
// Worker claim query: status ∈ {PENDING, RETRY_PENDING} AND nextAttemptAt <= now.
NotificationJobSchema.index({ status: 1, nextAttemptAt: 1 });
NotificationJobSchema.index({ orderId: 1 });
NotificationJobSchema.index({ createdAt: -1 });
// Admin history / stats per channel (ZALO_BOT vs ZALO_ZBS).
NotificationJobSchema.index({ channel: 1, createdAt: -1 });
