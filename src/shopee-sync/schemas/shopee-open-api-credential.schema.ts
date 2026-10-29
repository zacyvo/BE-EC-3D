import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShopeeOpenApiCredentialDocument = ShopeeOpenApiCredential & Document;

export enum ShopeeOpenApiCredentialStatus {
  ACTIVE = 'ACTIVE',
  /** Refresh token / shop authorization rejected or expired — an admin must re-connect. */
  REAUTH_REQUIRED = 'REAUTH_REQUIRED',
}

/**
 * The connected Shopee shop's Open API tokens — a single row (key "default"): Luxe Glow
 * syncs exactly one Shopee shop (same assumption as SHOPEE_SYNC_DEFAULT_SHOP_ID).
 *
 * Shopee's refresh token ROTATES on every refresh (valid 30 days), so it can only live in
 * the DB — AES-256-GCM encrypted with SHOPEE_TOKEN_ENCRYPTION_KEY. No API ever returns
 * the tokens, only timestamps/status.
 */
@Schema({ timestamps: true, collection: 'shopee_open_api_credentials' })
export class ShopeeOpenApiCredential {
  _id: Types.ObjectId;

  @Prop({ required: true }) key: string;

  @Prop({ required: true, enum: Object.values(ShopeeOpenApiCredentialStatus), type: String, default: ShopeeOpenApiCredentialStatus.ACTIVE })
  status: ShopeeOpenApiCredentialStatus;

  /** Shopee's numeric shop_id (string to avoid any precision concern). */
  @Prop({ required: true }) shopeeShopId: string;
  @Prop() shopName?: string;
  @Prop() region?: string;

  @Prop() accessTokenEnc?: string;
  @Prop() accessTokenExpiresAt?: Date;
  @Prop() refreshTokenEnc?: string;
  /** Estimate: obtained + 30 days (docs). */
  @Prop() refreshTokenExpiresAt?: Date;
  /** From shop/get_shop_info `expire_time` — the shop authorization itself (≈ 1 year). */
  @Prop() authorizationExpiresAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Staff' }) authorizedBy?: Types.ObjectId;
  @Prop() authorizedAt?: Date;

  @Prop() lastRefreshAt?: Date;
  @Prop() lastErrorCode?: string;
  @Prop() lastErrorMessage?: string;

  /** DB lease so only one worker/instance spends the rotating refresh token. */
  @Prop() refreshLockOwner?: string;
  @Prop() refreshLockUntil?: Date;

  /** DB lease so manual + scheduled order syncs never run concurrently (multi-instance safe). */
  @Prop() orderSyncLockOwner?: string;
  @Prop() orderSyncLockUntil?: Date;
  @Prop() lastOrderSyncAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ShopeeOpenApiCredentialSchema = SchemaFactory.createForClass(ShopeeOpenApiCredential);
ShopeeOpenApiCredentialSchema.index({ key: 1 }, { unique: true });
