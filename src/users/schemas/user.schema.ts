import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ _id: false })
export class OldAddress {
  @Prop() ward?: string;
  @Prop({ required: true }) district: string;
  @Prop({ required: true }) province: string;
  @Prop() wardCode?: number;
  @Prop({ required: true }) districtCode: number;
}

const OldAddressSchema = SchemaFactory.createForClass(OldAddress);

@Schema({ _id: false })
export class Address {
  @Prop({ required: true }) street: string;
  @Prop({ required: true }) ward: string;
  @Prop({ default: '' }) district: string;
  @Prop({ required: true }) city: string;
  @Prop({ default: false }) isDefault: boolean;
  /** Pre-merger (2025) address this was entered/converted from, if any. Absent = new address entered directly. */
  @Prop({ type: OldAddressSchema }) oldAddress?: OldAddress;
}

const AddressSchema = SchemaFactory.createForClass(Address);

@Schema({ timestamps: true })
export class User {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ select: false })
  password?: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop()
  avatar?: string;

  @Prop({ default: 'local', enum: ['local', 'google', 'facebook'] })
  provider: string;

  @Prop()
  providerId?: string;

  @Prop({ select: false })
  refreshToken?: string;

  @Prop({ select: false })
  resetPasswordToken?: string;

  @Prop({ select: false })
  resetPasswordExpires?: Date;

  @Prop({ type: [AddressSchema], default: [] })
  addresses: Address[];

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  @Prop({ default: false })
  isBlocked: boolean;

  @Prop()
  blockedAt?: Date;

  @Prop()
  blockedBy?: string;

  @Prop()
  dob?: Date;

  @Prop({ select: false })
  deleteAccountCode?: string;

  @Prop({ select: false })
  deleteAccountCodeExpires?: Date;

  @Prop({ select: false, default: 0 })
  deleteAccountAttempts?: number;

  @Prop({ select: false })
  deleteAccountAttemptsDate?: string; // 'YYYY-MM-DD'

  /** Created automatically by admin order flow when phone not in DB */
  @Prop({ default: false })
  isGuest: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Indexes
UserSchema.index({ email: 1 });
UserSchema.index({ isDeleted: 1 });
UserSchema.index({ phone: 1 }, { unique: true, sparse: true }); // sparse: allows multiple docs with no phone

// Default query filter
UserSchema.pre(/^find/, function (this: any, next: () => void) {
  if (this.getFilter().isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});
