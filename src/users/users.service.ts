import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

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

  async findById(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findById(id).exec();
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

  async updateProfile(
    userId: string,
    data: { name?: string; phone?: string; avatar?: string },
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: data }, { new: true })
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
