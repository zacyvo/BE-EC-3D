import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SettingDocument = Setting & Document;

/**
 * Singleton: chỉ có duy nhất một document trong collection này (xem SettingsService.get()).
 * Gom mọi cấu hình chung của hệ thống mà admin có thể chỉnh sửa từ trang Cài đặt.
 */
@Schema({ timestamps: true })
export class Setting {
  _id: Types.ObjectId;

  /** URL trang demo sẽ chuyển hướng đến. */
  @Prop({ default: 'https://luxe-glow.vn', trim: true })
  demoRedirectUrl: string;

  /** Số giây chờ trên trang demo trước khi chuyển hướng. */
  @Prop({ default: 3, min: 1 })
  demoRedirectSeconds: number;

  createdAt: Date;
  updatedAt: Date;
}

export const SettingSchema = SchemaFactory.createForClass(Setting);
