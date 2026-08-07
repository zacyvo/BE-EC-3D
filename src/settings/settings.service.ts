import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Setting, SettingDocument } from './schemas/setting.schema';
import { UpdateSettingDto } from './dto/setting.dto';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(Setting.name)
    private readonly settingModel: Model<SettingDocument>,
    private readonly auditService: AuditService,
  ) {}

  /** Luôn có đúng một document cấu hình — upsert atomic để tránh tạo trùng khi có request đồng thời. */
  async get(): Promise<SettingDocument> {
    return this.settingModel
      .findOneAndUpdate({}, { $setOnInsert: {} }, { upsert: true, new: true })
      .exec();
  }

  async update(dto: UpdateSettingDto, staffId: string): Promise<SettingDocument> {
    const before = await this.get();
    const beforeData = { demoRedirectUrl: before.demoRedirectUrl, demoRedirectSeconds: before.demoRedirectSeconds };

    const updated = await this.settingModel
      .findByIdAndUpdate(before._id, { $set: dto }, { new: true })
      .exec();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'SETTINGS_UPDATE',
      module: 'settings',
      targetId: before._id.toString(),
      beforeData,
      afterData: { ...dto },
    });

    return updated!;
  }
}
