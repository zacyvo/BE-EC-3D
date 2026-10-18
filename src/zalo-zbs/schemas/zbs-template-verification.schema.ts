import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ZbsTemplateVerificationDocument = ZbsTemplateVerification & Document;

@Schema({ _id: false })
export class ZbsTemplateParam {
  @Prop({ required: true }) name: string;
  @Prop() require?: boolean;
  @Prop() type?: string;
  @Prop() maxLength?: number;
  @Prop() minLength?: number;
  @Prop() acceptNull?: boolean;
}
const ZbsTemplateParamSchema = SchemaFactory.createForClass(ZbsTemplateParam);

/**
 * Last known state of one configured template (GET /template/info/v2). Sending is gated on
 * this row: status ENABLE + the ENV param mapping matching listParams — or an explicit
 * ZALO_ZBS_TEMPLATE_MANUALLY_VERIFIED attestation when the app lacks the template permission.
 */
@Schema({ timestamps: true, collection: 'zalo_zbs_templates' })
export class ZbsTemplateVerification {
  _id: Types.ObjectId;

  /** e.g. ORDER_CONFIRMATION */
  @Prop({ required: true }) templateKey: string;
  @Prop({ required: true }) templateId: string;

  /** PENDING_REVIEW | ENABLE | REJECT | DISABLE | DELETE — or UNVERIFIED / SEND_REJECTED_<code>. */
  @Prop({ required: true }) status: string;
  @Prop() reason?: string;
  @Prop() templateName?: string;
  @Prop() templateTag?: string;
  @Prop() templateQuality?: string;
  @Prop({ type: [ZbsTemplateParamSchema], default: [] }) listParams: ZbsTemplateParam[];
  @Prop() buttonCount?: number;
  /** price_sdt from template info (VND, as reported by Zalo) — used only for estimates. */
  @Prop() priceSdt?: number;
  @Prop() previewUrl?: string;

  @Prop() verifiedAt?: Date;
  @Prop() lastCheckAt?: Date;
  @Prop() lastCheckErrorCode?: string;
  @Prop() lastCheckErrorMessage?: string;
  /** RETRYABLE when the last check failed for a transient reason (network / 5xx). */
  @Prop() lastCheckErrorClass?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ZbsTemplateVerificationSchema = SchemaFactory.createForClass(ZbsTemplateVerification);
ZbsTemplateVerificationSchema.index({ templateKey: 1, templateId: 1 }, { unique: true });
