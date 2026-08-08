import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { SOCIAL_ICON_KEYS, SocialIconKey } from '../constants/social-icons.constant';

export type NfcProfileDocument = NfcProfile & Document;

@Schema({ _id: true })
export class SocialLink {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: SOCIAL_ICON_KEYS })
  icon: SocialIconKey;

  @Prop({ required: true, trim: true, maxlength: 300 })
  value: string;
}

export const SocialLinkSchema = SchemaFactory.createForClass(SocialLink);

@Schema({ timestamps: true, collection: 'nfc_profiles' })
export class NfcProfile {
  _id: Types.ObjectId;

  /** Mã quản lý riêng tư — admin gán khi tạo, khớp với thẻ NFC vật lý. URL: /nfc/{nfcId} */
  @Prop({ required: true, unique: true, trim: true })
  nfcId: string;

  /** Mã công khai tự sinh — dùng cho trang xem public. URL: /nfc/{nfcCode} */
  @Prop({ required: true, unique: true, trim: true })
  nfcCode: string;

  @Prop({ default: false })
  isActivated: boolean;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ select: false })
  password?: string;

  @Prop()
  termsAcceptedAt?: Date;

  @Prop({ type: [SocialLinkSchema], default: [] })
  socialLinks: SocialLink[];

  /** Admin bật/tắt thẻ — thẻ tắt sẽ không đăng nhập/xem public được */
  @Prop({ default: true })
  isActive: boolean;

  // Chống dò mật khẩu — cùng cơ chế với contract.schema.ts
  @Prop({ default: 0 })
  loginAttempts: number;

  @Prop()
  lockedUntil?: Date;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  @Prop({ type: Types.ObjectId, ref: 'Staff', required: true })
  createdBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const NfcProfileSchema = SchemaFactory.createForClass(NfcProfile);

NfcProfileSchema.index({ nfcId: 1 });
NfcProfileSchema.index({ nfcCode: 1 });
NfcProfileSchema.index({ isDeleted: 1 });
NfcProfileSchema.index({ phone: 1 }, { sparse: true });

NfcProfileSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});
