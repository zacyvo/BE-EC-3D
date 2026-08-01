import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeOrderSyncIssueDocument = ShopeeOrderSyncIssue & Document;

export enum ShopeeOrderIssueStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

@Schema({ _id: false })
export class ShopeeOrderIssueItemCandidate {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true }) productId: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) score: number;
}

const ShopeeOrderIssueItemCandidateSchema = SchemaFactory.createForClass(ShopeeOrderIssueItemCandidate);

/** One Shopee order line item that could not be confidently matched to a catalog
 * Product (Order.items[].productId is a required reference, so unmatched items block
 * order creation entirely until a staff member picks the right product). */
@Schema({ _id: false })
export class ShopeeOrderIssueItem {
  @Prop({ required: true }) productName: string;
  @Prop() variantLabel?: string;
  @Prop({ required: true }) quantity: number;
  @Prop({ required: true }) unitPrice: number;
  @Prop({ default: false }) matched: boolean;
  /** Set when `matched` is true — the auto-resolved product, so resolveIssue()
   * doesn't need an explicit override for lines that already matched confidently. */
  @Prop({ type: Types.ObjectId, ref: 'Product' }) matchedProductId?: Types.ObjectId;
  @Prop({ type: [ShopeeOrderIssueItemCandidateSchema], default: [] }) candidates: ShopeeOrderIssueItemCandidate[];
}

const ShopeeOrderIssueItemSchema = SchemaFactory.createForClass(ShopeeOrderIssueItem);

@Schema({ _id: false })
export class ShopeeOrderIssueShippingPreview {
  @Prop({ required: true }) recipientName: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true }) street: string;
  @Prop({ required: true }) ward: string;
  @Prop({ default: '' }) district: string;
  @Prop({ required: true }) city: string;
  @Prop() note?: string;
}

const ShopeeOrderIssueShippingPreviewSchema = SchemaFactory.createForClass(ShopeeOrderIssueShippingPreview);

/**
 * A Shopee order that could not be auto-created — one doc per `orderCode`
 * (upserted across uploads so re-uploading the same file doesn't duplicate the
 * review entry). Stays OPEN until a staff member resolves (picks the right
 * product(s), which creates the Order) or dismisses it (e.g. a test order).
 */
@Schema({ timestamps: true, collection: 'shopee_order_sync_issues' })
export class ShopeeOrderSyncIssue {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true }) orderCode: string;
  @Prop({ type: [String], default: [] }) reasons: string[];

  /** Raw parsed source row(s) for this order — kept for audit/debugging only, never
   * read back by matching logic. */
  @Prop({ type: [Object], default: [] }) rawRows: Record<string, unknown>[];

  @Prop({ type: [ShopeeOrderIssueItemSchema], default: [] }) items: ShopeeOrderIssueItem[];
  @Prop({ type: ShopeeOrderIssueShippingPreviewSchema, required: true }) shippingInfoPreview: ShopeeOrderIssueShippingPreview;

  @Prop({ required: true, enum: Object.values(ShopeeOrderIssueStatus), type: String, default: ShopeeOrderIssueStatus.OPEN })
  status: ShopeeOrderIssueStatus;

  @Prop({ type: Types.ObjectId, ref: 'Order' }) resolvedOrderId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'ShopeeOrderSyncBatch', required: true }) lastBatchId: Types.ObjectId;

  @Prop({ required: true }) firstSeenAt: Date;
  @Prop({ required: true }) lastSeenAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ShopeeOrderSyncIssueSchema = SchemaFactory.createForClass(ShopeeOrderSyncIssue);
ShopeeOrderSyncIssueSchema.index({ status: 1, lastSeenAt: -1 });
