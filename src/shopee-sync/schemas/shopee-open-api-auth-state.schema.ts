import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeOpenApiAuthStateDocument = ShopeeOpenApiAuthState & Document;

/**
 * One pending "Kết nối Shopee" attempt. The Shopee callback is a plain browser redirect
 * (no staff JWT), so the opaque `state` we append to the redirect URL is what proves the
 * callback belongs to an authorization a SUPER_ADMIN actually started (CSRF guard).
 * Single-use; expired rows are removed by the TTL index.
 */
@Schema({ timestamps: true, collection: 'shopee_open_api_auth_states' })
export class ShopeeOpenApiAuthState {
  _id: Types.ObjectId;

  /** SHA-256 hex of the raw state — the raw value only ever lives in the redirect URL. */
  @Prop({ required: true }) stateHash: string;
  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true }) staffId: Types.ObjectId;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) usedAt: Date | null;
}

export const ShopeeOpenApiAuthStateSchema = SchemaFactory.createForClass(ShopeeOpenApiAuthState);
ShopeeOpenApiAuthStateSchema.index({ stateHash: 1 }, { unique: true });
ShopeeOpenApiAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
