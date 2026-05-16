import { Injectable, NotFoundException, ConflictException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { MailService } from '../mail/mail.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly mailService: MailService,
  ) {}

  async create(data: {
    email: string;
    password?: string;
    name: string;
    phone?: string;
    avatar?: string;
    provider?: string;
    providerId?: string;
  }): Promise<UserDocument> {
    const existing = await this.userModel.findOne({ email: data.email }).select('+password').exec();
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    let hashedPassword: string | undefined;
    if (data.password) {
      hashedPassword = await bcrypt.hash(data.password, 12);
    }

    const user = new this.userModel({
      ...data,
      password: hashedPassword,
    });

    return user.save();
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).select('+password +refreshToken').exec();
  }

  async findByEmailOrPhone(identifier: string): Promise<UserDocument | null> {
    const isEmail = identifier.includes('@');
    if (isEmail) {
      return this.findByEmail(identifier);
    }
    const normalizedPhone = identifier.startsWith('+84')
      ? '0' + identifier.slice(3)
      : identifier;
    return this.userModel.findOne({ phone: normalizedPhone }).select('+password +refreshToken').exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findById(id).exec();
  }

  async findByPhone(phone: string): Promise<UserDocument | null> {
    const normalized = phone.startsWith('+84') ? '0' + phone.slice(3) : phone;
    return this.userModel.findOne({ phone: normalized }).exec();
  }

  async findOrCreateByPhone(
    phone: string,
    name: string,
  ): Promise<{ user: UserDocument; created: boolean }> {
    const normalized = phone.startsWith('+84') ? '0' + phone.slice(3) : phone;
    const existing = await this.userModel.findOne({ phone: normalized }).exec();
    if (existing) return { user: existing, created: false };

    const tempEmail = `guest_${normalized}@guest.luxe-glow.vn`;
    const user = new this.userModel({
      email: tempEmail,
      name: name || `Khách ${normalized}`,
      phone: normalized,
      provider: 'local',
      isGuest: true,
    });
    await user.save();
    return { user, created: true };
  }

  async findOrCreateOAuthUser(data: {
    email: string;
    name: string;
    avatar?: string;
    provider: string;
    providerId: string;
  }): Promise<UserDocument> {
    // Try find by email (merge account)
    let user = await this.userModel.findOne({ email: data.email }).select('+refreshToken').exec();
    if (user) {
      // Update provider info if not set
      if (!user.providerId) {
        user.provider = data.provider;
        user.providerId = data.providerId;
        if (data.avatar && !user.avatar) user.avatar = data.avatar;
        await user.save();
      }
      return user;
    }

    user = new this.userModel({
      email: data.email,
      name: data.name,
      avatar: data.avatar,
      provider: data.provider,
      providerId: data.providerId,
    });

    return user.save();
  }

  async updateRefreshToken(userId: string, refreshToken: string | null): Promise<void> {
    const hashed = refreshToken ? await bcrypt.hash(refreshToken, 10) : null;
    await this.userModel.findByIdAndUpdate(userId, {
      $set: { refreshToken: hashed },
    }).exec();
  }

  async verifyRefreshToken(userId: string, token: string): Promise<boolean> {
    const user = await this.userModel.findById(userId).select('+refreshToken').exec();
    if (!user?.refreshToken) return false;
    return bcrypt.compare(token, user.refreshToken);
  }

  async setResetPasswordToken(userId: string, token: string, expires: Date): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      resetPasswordToken: token,
      resetPasswordExpires: expires,
    }).exec();
  }

  async findByResetToken(token: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({
        resetPasswordToken: token,
        resetPasswordExpires: { $gt: new Date() },
      })
      .select('+resetPasswordToken +resetPasswordExpires')
      .exec();
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.userModel.findByIdAndUpdate(userId, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordExpires: null,
    }).exec();
  }

  async findAll(query: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = query;
    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async softDelete(userId: string, deletedBy: string): Promise<void> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deletedBy = deletedBy;
    await user.save();
  }

  async toggleBlock(userId: string, blockedBy: string): Promise<{ isBlocked: boolean }> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    user.isBlocked = !user.isBlocked;
    user.blockedAt = user.isBlocked ? new Date() : undefined;
    user.blockedBy = user.isBlocked ? blockedBy : undefined;
    await user.save();
    return { isBlocked: user.isBlocked };
  }

  async updateProfile(
    userId: string,
    data: { name?: string; phone?: string; avatar?: string; dob?: Date },
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: data }, { new: true })
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userModel.findById(userId).select('+password').exec();
    if (!user) throw new NotFoundException('User not found');
    if (!user.password) throw new BadRequestException('This account uses social login');
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) throw new UnauthorizedException('Mật khẩu hiện tại không đúng');
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.userModel.findByIdAndUpdate(userId, { password: hashed }).exec();
  }

  async deleteSelf(userId: string): Promise<void> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    user.isDeleted = true;
    user.deletedAt = new Date();
    await user.save();
  }

  // ── Delete-account email verification ──────────────────────────────────────

  /** Generate & email a 6-char code. Rate-limited: 1 request per minute. */
  async requestDeleteAccountCode(userId: string): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('+deleteAccountCode +deleteAccountCodeExpires')
      .exec();
    if (!user) throw new NotFoundException('User not found');

    // Prevent spamming: if a valid code exists and was issued < 60s ago, reject
    if (
      user.deleteAccountCode &&
      user.deleteAccountCodeExpires &&
      user.deleteAccountCodeExpires.getTime() > Date.now() + 4 * 60 * 1000 // > 4 min remaining means < 1 min old
    ) {
      throw new BadRequestException('Vui lòng đợi ít nhất 1 phút trước khi yêu cầu mã mới');
    }

    // Generate 6-char uppercase alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }

    const hashedCode = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await this.userModel.findByIdAndUpdate(userId, {
      deleteAccountCode: hashedCode,
      deleteAccountCodeExpires: expires,
    }).exec();

    await this.mailService.sendDeleteAccountCode(user.email, code);
  }

  /** Verify code and soft-delete. Max 5 wrong attempts per day. */
  async confirmDeleteAccount(userId: string, code: string): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('+deleteAccountCode +deleteAccountCodeExpires +deleteAccountAttempts +deleteAccountAttemptsDate')
      .exec();
    if (!user) throw new NotFoundException('User not found');

    // Check daily attempt limit
    const today = new Date().toISOString().slice(0, 10);
    const sameDay = user.deleteAccountAttemptsDate === today;
    const attempts = sameDay ? (user.deleteAccountAttempts ?? 0) : 0;

    if (attempts >= 5) {
      throw new BadRequestException('Bạn đã nhập sai quá 5 lần hôm nay. Vui lòng thử lại vào ngày mai.');
    }

    // Check code existence / expiry
    if (!user.deleteAccountCode || !user.deleteAccountCodeExpires) {
      throw new BadRequestException('Chưa có mã xác nhận. Vui lòng yêu cầu mã mới.');
    }
    if (user.deleteAccountCodeExpires < new Date()) {
      throw new BadRequestException('Mã xác nhận đã hết hạn. Vui lòng yêu cầu mã mới.');
    }

    const match = await bcrypt.compare(code.toUpperCase(), user.deleteAccountCode);
    if (!match) {
      // Increment attempt counter
      await this.userModel.findByIdAndUpdate(userId, {
        deleteAccountAttempts: attempts + 1,
        deleteAccountAttemptsDate: today,
      }).exec();
      const remaining = 5 - (attempts + 1);
      throw new UnauthorizedException(
        remaining > 0
          ? `Mã không đúng. Bạn còn ${remaining} lần thử trong ngày hôm nay.`
          : 'Mã không đúng. Bạn đã dùng hết lượt thử hôm nay.',
      );
    }

    // Code correct — soft-delete and clear sensitive fields
    user.isDeleted = true;
    user.deletedAt = new Date();
    (user as any).deleteAccountCode = undefined;
    (user as any).deleteAccountCodeExpires = undefined;
    (user as any).deleteAccountAttempts = 0;
    await user.save();
  }

  async addAddress(
    userId: string,
    address: { street: string; ward: string; district?: string; city: string; isDefault: boolean },
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $push: { addresses: address } },
        { new: true },
      )
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateAddress(
    userId: string,
    index: number,
    data: { street?: string; ward?: string; district?: string; city?: string; isDefault?: boolean },
  ): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    if (index < 0 || index >= (user.addresses?.length ?? 0)) {
      throw new NotFoundException('Address not found');
    }
    if (data.isDefault) {
      user.addresses.forEach((_, i) => {
        (user.addresses[i] as any).isDefault = i === index;
      });
    }
    if (data.street !== undefined) (user.addresses[index] as any).street = data.street;
    if (data.ward !== undefined) (user.addresses[index] as any).ward = data.ward;
    if (data.district !== undefined) (user.addresses[index] as any).district = data.district;
    if (data.city !== undefined) (user.addresses[index] as any).city = data.city;
    user.markModified('addresses');
    await user.save();
    return user;
  }

  async removeAddress(userId: string, index: number): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    if (index < 0 || index >= (user.addresses?.length ?? 0)) {
      throw new NotFoundException('Address not found');
    }
    user.addresses.splice(index, 1);
    user.markModified('addresses');
    await user.save();
    return user;
  }
}
