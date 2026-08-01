import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeSyncSessionDocument = ShopeeSyncSession & Document;

/**
 * Backend-persisted lifecycle of one sync attempt. NOT to be confused with the
 * extension's own ephemeral UI phases (CHECKING_EXTENSION, OPENING_SHOPEE, ...)
 * which only ever live in chrome.storage.session / the Admin page — those never
 * reach the backend. This is the durable, source-of-truth state machine:
 *
 *   CREATED -> LIST_SNAPSHOT_UPLOADED -> READY_FOR_PREVIEW -> PREVIEWED -> COMMITTED
 *                                                                       \-> CANCELLED
 *   (any state) -> FAILED | CANCELLED | EXPIRED
 */
export enum ShopeeSyncSessionStatus {
  CREATED = 'CREATED',
  LIST_SNAPSHOT_UPLOADED = 'LIST_SNAPSHOT_UPLOADED',
  READY_FOR_PREVIEW = 'READY_FOR_PREVIEW',
  PREVIEWED = 'PREVIEWED',
  COMMITTED = 'COMMITTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/**
 * FULL   — the "usual" flow: extension pages through Shopee's whole product List,
 *          uploads the list-snapshot, and any previously-synced product absent from
 *          that snapshot is eligible to be marked MISSING (see ShopeeSyncService.preview/commit).
 * MANUAL — admin supplies exact Shopee product_id(s) to fetch/sync (no List phase at
 *          all). Missing-product detection MUST be skipped entirely for these sessions —
 *          a snapshot of 1-2 explicitly-picked ids must never be treated as "the full
 *          catalog" or every other already-synced product would be false-positively
 *          flagged as no-longer-on-Shopee.
 */
export enum ShopeeSyncMode {
  FULL = 'FULL',
  MANUAL = 'MANUAL',
}

@Schema({ timestamps: true, collection: 'shopee_sync_sessions' })
export class ShopeeSyncSession {
  _id: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  shopId: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  adminId: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(ShopeeSyncSessionStatus), type: String, default: ShopeeSyncSessionStatus.CREATED })
  status: ShopeeSyncSessionStatus;

  @Prop({ required: true, enum: Object.values(ShopeeSyncMode), type: String, default: ShopeeSyncMode.FULL })
  syncMode: ShopeeSyncMode;

  @Prop({ default: false })
  forceFullSync: boolean;

  /** SHA-256 hex of the raw upload token — the raw value is returned once and never stored. */
  @Prop({ required: true, select: false })
  uploadTokenHash: string;

  @Prop({ required: true })
  uploadTokenExpiresAt: Date;

  @Prop({ type: Number, default: null })
  expectedTotal: number | null;

  @Prop({ default: 0 }) collectedTotal: number;
  @Prop({ default: 0 }) newCount: number;
  @Prop({ default: 0 }) changedCount: number;
  @Prop({ default: 0 }) unchangedCount: number;
  @Prop({ default: 0 }) missingCount: number;
  @Prop({ default: 0 }) failedCount: number;

  /** externalProductId list still awaiting a Detail upload for this session. */
  @Prop({ type: [String], default: [] })
  pendingDetailProductIds: string[];

  @Prop({ type: String, default: null })
  extensionVersion: string | null;

  @Prop({ type: String, default: null })
  adapterVersion: string | null;

  @Prop({ type: Object, default: null })
  previewSummary: Record<string, unknown> | null;

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  committedAt: Date | null;

  @Prop({ type: String, default: null })
  errorCode: string | null;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const ShopeeSyncSessionSchema = SchemaFactory.createForClass(ShopeeSyncSession);

ShopeeSyncSessionSchema.index({ shopId: 1, createdAt: -1 });
ShopeeSyncSessionSchema.index({ status: 1, uploadTokenExpiresAt: 1 });
