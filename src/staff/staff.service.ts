import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Staff, StaffDocument, StaffRole } from './schemas/staff.schema';

@Injectable()
export class StaffService {
  constructor(@InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>) {}

  async create(data: {
    email: string;
    password: string;
    name: string;
    role: StaffRole;
    createdBy: string;
  }): Promise<StaffDocument> {
    const existing = await this.staffModel.findOne({ email: data.email }).exec();
    if (existing) throw new ConflictException('Email already registered');

    const hashed = await bcrypt.hash(data.password, 12);
    const staff = new this.staffModel({ ...data, password: hashed });
    return staff.save();
  }

  async findByEmail(email: string): Promise<StaffDocument | null> {
    return this.staffModel
      .findOne({ email: email.toLowerCase(), isActive: true })
      .select('+password +refreshToken')
      .exec();
  }

  async findById(id: string): Promise<StaffDocument | null> {
    return this.staffModel.findById(id).exec();
  }

  async findAll(query: { page: number; limit: number }) {
    const { page, limit } = query;
    const [data, total] = await Promise.all([
      this.staffModel
        .find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.staffModel.countDocuments().exec(),
    ]);
    return { data, total, page, limit };
  }

  async updateRefreshToken(staffId: string, refreshToken: string | null): Promise<void> {
    const hashed = refreshToken ? await bcrypt.hash(refreshToken, 10) : null;
    await this.staffModel.findByIdAndUpdate(staffId, { refreshToken: hashed }).exec();
  }

  async verifyRefreshToken(staffId: string, token: string): Promise<boolean> {
    const staff = await this.staffModel.findById(staffId).select('+refreshToken').exec();
    if (!staff?.refreshToken) return false;
    return bcrypt.compare(token, staff.refreshToken);
  }

  async softDelete(staffId: string, deletedBy: string, requestorRole: StaffRole): Promise<void> {
    if (requestorRole !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only SUPER_ADMIN can delete staff');
    }
    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) throw new NotFoundException('Staff not found');
    staff.isDeleted = true;
    staff.deletedAt = new Date();
    staff.deletedBy = deletedBy;
    await staff.save();
  }

  async toggleActive(staffId: string): Promise<StaffDocument> {
    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) throw new NotFoundException('Staff not found');
    staff.isActive = !staff.isActive;
    return staff.save();
  }
}
