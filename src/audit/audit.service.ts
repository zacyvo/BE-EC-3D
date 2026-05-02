import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';

interface LogData {
  actorId: string;
  actorType?: 'user' | 'staff';
  action: string;
  module: string;
  beforeData?: Record<string, unknown>;
  afterData?: Record<string, unknown>;
  targetId?: string;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditModel: Model<AuditLogDocument>,
  ) {}

  async log(data: LogData): Promise<void> {
    try {
      await this.auditModel.create({
        actorId: data.actorId,
        actorType: data.actorType || 'user',
        action: data.action,
        module: data.module,
        beforeData: data.beforeData,
        afterData: data.afterData,
        targetId: data.targetId,
        ipAddress: data.ipAddress,
      });
    } catch (err) {
      // Non-blocking: audit log failure should not break the main flow
      console.error('AuditLog error:', err);
    }
  }

  async findAll(query: {
    page: number;
    limit: number;
    module?: string;
    actorId?: string;
    action?: string;
  }) {
    const { page, limit, module: mod, actorId, action } = query;
    const filter: Record<string, unknown> = {};
    if (mod) filter.module = mod;
    if (actorId) filter.actorId = actorId;
    if (action) filter.action = action;

    const [data, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit };
  }
}
