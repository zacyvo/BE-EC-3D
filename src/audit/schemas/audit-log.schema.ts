import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

@Schema({ timestamps: true })
export class AuditLog {
  @Prop({ required: true }) actorId: string;
  @Prop({ default: 'user', enum: ['user', 'staff'] }) actorType: string;
  @Prop({ required: true }) action: string;
  @Prop({ required: true }) module: string;
  @Prop({ type: Object }) beforeData?: Record<string, unknown>;
  @Prop({ type: Object }) afterData?: Record<string, unknown>;
  @Prop() targetId?: string;
  @Prop() ipAddress?: string;
  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ actorId: 1 });
AuditLogSchema.index({ module: 1 });
AuditLogSchema.index({ createdAt: -1 });
