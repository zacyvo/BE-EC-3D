import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PaymentConfirmationSource } from '../../orders/schemas/order.schema';

export type PaymentEventDocument = PaymentEvent & Document;

export enum PaymentEventAction {
  CONFIRM_PAYMENT = 'CONFIRM_PAYMENT',
  /** Zalo "Danh sách" — an admin read the pending bank-transfer orders (customer names). */
  LIST_PENDING = 'LIST_PENDING',
}

export enum PaymentEventResult {
  /** Zalo command accepted for processing — replaced by the final result below. */
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  ALREADY_PAID = 'ALREADY_PAID',
  NOT_FOUND = 'NOT_FOUND',
  AMBIGUOUS = 'AMBIGUOUS',
  NOT_BANK_TRANSFER = 'NOT_BANK_TRANSFER',
  INELIGIBLE = 'INELIGIBLE',
  AMOUNT_CHANGED = 'AMOUNT_CHANGED',
  CONFLICT = 'CONFLICT',
  INVALID_COMMAND = 'INVALID_COMMAND',
  EXPIRED_COMMAND = 'EXPIRED_COMMAND',
  NOT_PRIVATE_CHAT = 'NOT_PRIVATE_CHAT',
  ERROR = 'ERROR',
  /** LIST_PENDING answered. */
  LISTED = 'LISTED',
}

/**
 * Audit trail of payment confirmations by authorized admins (Admin CMS + Zalo Bot), one row per
 * attempt. Doubles as the Zalo webhook idempotency record: a re-delivered message hits the unique
 * `dedupKey` and is dropped before anything is looked up or replied to. Unauthorized senders are
 * NOT recorded here (anyone can message the bot) — they only produce a masked log line.
 */
@Schema({ timestamps: true, collection: 'payment_events' })
export class PaymentEvent {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(PaymentEventAction) }) action: PaymentEventAction;
  @Prop({ required: true, enum: Object.values(PaymentConfirmationSource) }) source: PaymentConfirmationSource;
  @Prop({ required: true, enum: Object.values(PaymentEventResult) }) result: PaymentEventResult;

  @Prop({ type: Types.ObjectId, ref: 'Order' }) orderId?: Types.ObjectId;
  /** What identified the order: the payment reference, or the code the admin typed. */
  @Prop() orderCode?: string;

  /** Staff id (CMS) or "zalo:<user id>" (Bot). */
  @Prop({ required: true }) actorId: string;
  @Prop() actorName?: string;
  @Prop() senderZaloId?: string;
  @Prop() providerMessageId?: string;
  /** Zalo: message_id (or a hash of sender/date/text when absent). Unique → no double processing. */
  @Prop() dedupKey?: string;

  @Prop() previousStatus?: string;
  @Prop() newStatus?: string;
  @Prop({ min: 0 }) amount?: number;
  @Prop() errorReason?: string;
  /** Zalo reply outcome, e.g. ACCEPTED / FAILED:HTTP_401 — the bot reply can fail after the update. */
  @Prop() replyStatus?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);
PaymentEventSchema.index({ dedupKey: 1 }, { unique: true, sparse: true });
// At most one successful confirmation per order — a duplicate can never write a 2nd success row.
PaymentEventSchema.index(
  { orderId: 1, action: 1 },
  { unique: true, partialFilterExpression: { result: PaymentEventResult.SUCCESS } },
);
PaymentEventSchema.index({ orderId: 1, createdAt: -1 });
PaymentEventSchema.index({ createdAt: -1 });
