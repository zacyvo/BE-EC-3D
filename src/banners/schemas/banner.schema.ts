import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { BannerLinkType, BannerPlacement } from '../banner.constants';

export type BannerDocument = Banner & Document;

/**
 * Banner / Hero quảng cáo trên trang chủ. Một banner hiển thị khi
 * isActive && (startAt trống hoặc <= now) && (endAt trống hoặc > now).
 * Xem backend/docs/HOME_BANNERS.md.
 */
@Schema({ timestamps: true })
export class Banner {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(BannerPlacement), default: BannerPlacement.HERO })
  placement: BannerPlacement;

  /** Tên nội bộ để admin phân biệt (VD "Sale 11.11"); cũng là alt mặc định của ảnh. */
  @Prop({ required: true, trim: true, maxlength: 120 })
  title: string;

  /** Mô tả ảnh cho người dùng trình đọc màn hình / SEO. */
  @Prop({ trim: true, maxlength: 200, default: '' })
  altText: string;

  /** Ảnh desktop/tablet (>= 900px) — bắt buộc. */
  @Prop({ required: true, trim: true })
  imageDesktop: string;

  /** Ảnh mobile (< 900px) — tuỳ chọn; trống thì mobile dùng ảnh desktop theo tỉ lệ desktop. */
  @Prop({ trim: true, default: '' })
  imageMobile: string;

  @Prop({ required: true, enum: Object.values(BannerLinkType), default: BannerLinkType.NONE })
  linkType: BannerLinkType;

  /** INTERNAL: "/..." ; EXTERNAL: http(s)/tel/mailto ; NONE/PRODUCT: rỗng. */
  @Prop({ trim: true, default: '' })
  linkUrl: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', default: null })
  productId: Types.ObjectId | null;

  @Prop({ default: false })
  openInNewTab: boolean;

  /** Công tắc bật/tắt thủ công — tắt thì không hiển thị dù đang trong khung thời gian. */
  @Prop({ default: true })
  isActive: boolean;

  /** Trống = hiển thị ngay khi bật. */
  @Prop({ type: Date, default: null })
  startAt: Date | null;

  /** Trống = không hết hạn. */
  @Prop({ type: Date, default: null })
  endAt: Date | null;

  /** Thứ tự trong slider, nhỏ hiển thị trước. */
  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: 0 })
  clickCount: number;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  createdBy: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Staff', default: null })
  updatedBy: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export const BannerSchema = SchemaFactory.createForClass(Banner);

BannerSchema.index({ placement: 1, isActive: 1, sortOrder: 1 });
