import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
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

  async findByEmailOrPhone(identifier: string): Promise<StaffDocument | null> {
    const isEmail = identifier.includes('@');
    if (isEmail) {
      return this.findByEmail(identifier);
    }
    const normalizedPhone = identifier.startsWith('+84')
      ? '0' + identifier.slice(3)
      : identifier;
    return this.staffModel
      .findOne({ phone: normalizedPhone, isActive: true })
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

  /** Xác nhận lại mật khẩu của chính staff (dùng cho thao tác nhạy cảm) */
  async verifyPassword(staffId: string, password: string): Promise<boolean> {
    const staff = await this.staffModel.findById(staffId).select('+password').exec();
    if (!staff?.password) return false;
    return bcrypt.compare(password, staff.password);
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

  // ─── SUPER_ADMIN: update staff info / role ──────────────────────────────────

  async updateById(
    staffId: string,
    data: { name?: string; role?: StaffRole },
  ): Promise<StaffDocument> {
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (name.length < 2 || name.length > 64) {
        throw new BadRequestException('Tên phải từ 2 đến 64 ký tự');
      }
      data.name = name;
    }
    const staff = await this.staffModel.findByIdAndUpdate(
      staffId,
      { $set: data },
      { new: true },
    ).exec();
    if (!staff) throw new NotFoundException('Staff not found');
    return staff;
  }

  // ─── Self-service (any authenticated staff) ────────────────────────────────

  async getMe(staffId: string): Promise<StaffDocument> {
    const staff = await this.staffModel.findById(staffId).exec();
    if (!staff) throw new NotFoundException('Staff not found');
    return staff;
  }

  async updateProfile(staffId: string, data: { name: string; phone?: string }): Promise<StaffDocument> {
    const name = data.name.trim();
    if (name.length < 2 || name.length > 64) {
      throw new BadRequestException('Tên phải từ 2 đến 64 ký tự');
    }

    const current = await this.staffModel.findById(staffId).exec();
    if (!current) throw new NotFoundException('Staff not found');

    const update: Record<string, unknown> = { name };

    if (data.phone !== undefined && data.phone !== '') {
      if (current.phone) {
        throw new BadRequestException('Số điện thoại đã được thiết lập và không thể thay đổi');
      }
      const VN_PHONE = /^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[0-9]|9[0-9])\d{7}$/;
      if (!VN_PHONE.test(data.phone)) {
        throw new BadRequestException('Số điện thoại không hợp lệ (VD: 0912345678)');
      }
      update.phone = data.phone;
    }

    const staff = await this.staffModel.findByIdAndUpdate(
      staffId,
      { $set: update },
      { new: true },
    ).exec();
    if (!staff) throw new NotFoundException('Staff not found');
    return staff;
  }

  async changePassword(staffId: string, currentPassword: string, newPassword: string): Promise<void> {
    const staff = await this.staffModel.findById(staffId).select('+password').exec();
    if (!staff) throw new NotFoundException('Staff not found');

    const valid = await bcrypt.compare(currentPassword, staff.password);
    if (!valid) throw new UnauthorizedException('Mật khẩu hiện tại không đúng');

    if (newPassword.length < 8 || newPassword.length > 32) {
      throw new BadRequestException('Mật khẩu mới phải từ 8 đến 32 ký tự');
    }
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      throw new BadRequestException('Mật khẩu cần có chữ hoa, chữ thường và số');
    }

    staff.password = await bcrypt.hash(newPassword, 12);
    await staff.save();
  }
}
