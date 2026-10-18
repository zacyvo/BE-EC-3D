import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZbsCredentialDocument = ZbsCredential & Document;

export enum ZbsCredentialStatus {
  ACTIVE = 'ACTIVE',
  /** Refresh token rejected/expired — an operator must re-authorize the OA. */
  REAUTH_REQUIRED = 'REAUTH_REQUIRED',
}

/**
 * The OA's OAuth tokens (one row, key "default"). Zalo refresh tokens are single-use and
 * rotate on every refresh, so after the first refresh the ENV value is stale and this row
 * is the source of truth. Both tokens are AES-256-GCM encrypted (zbs-token-crypto.ts);
 * the API only ever exposes timestamps/status, never the tokens.
 */
@Schema({ timestamps: true, collection: 'zalo_zbs_credentials' })
export class ZbsCredential {
  _id: Types.ObjectId;

  @Prop({ required: true }) key: string;
  @Prop({ required: true, enum: Object.values(ZbsCredentialStatus), default: ZbsCredentialStatus.ACTIVE })
  status: ZbsCredentialStatus;

  @Prop() accessTokenEnc?: string;
  /** Unknown (undefined) for an ENV-seeded access token — it is then used until Zalo rejects it. */
  @Prop() accessTokenExpiresAt?: Date;
  @Prop() refreshTokenEnc?: string;
  @Prop() refreshTokenObtainedAt?: Date;

  /** Fingerprint of the ENV seed this row was created from — a different ENV token means the
   * operator re-authorized, so the row is re-seeded. */
  @Prop() envSeedFingerprint?: string;
  /** ENV | OAUTH_CODE | REFRESH */
  @Prop() source?: string;

  @Prop() lastRefreshAt?: Date;
  @Prop() lastRefreshErrorCode?: string;
  @Prop() lastRefreshErrorMessage?: string;

  /** DB lock so only one worker/instance spends the single-use refresh token. */
  @Prop() refreshLockOwner?: string;
  @Prop() refreshLockUntil?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ZbsCredentialSchema = SchemaFactory.createForClass(ZbsCredential);
ZbsCredentialSchema.index({ key: 1 }, { unique: true });
