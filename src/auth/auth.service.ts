import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';
import { RegisterDto, LoginDto, StaffLoginDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly staffService: StaffService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── User Auth ─────────────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      name: dto.name,
      phone: dto.phone,
    });

    const tokens = await this.generateUserTokens(user._id.toString(), user.email);
    await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);

    await this.auditService.log({
      actorId: user._id.toString(),
      actorType: 'user',
      action: 'REGISTER',
      module: 'auth',
    });

    return { ...tokens, user: this.sanitizeUser(user) };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmailOrPhone(dto.identifier);
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.isBlocked) {
      return { user: { isBlocked: true } };
    }

    const tokens = await this.generateUserTokens(user._id.toString(), user.email);
    await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);

    await this.auditService.log({
      actorId: user._id.toString(),
      actorType: 'user',
      action: 'LOGIN',
      module: 'auth',
    });

    return { ...tokens, user: this.sanitizeUser(user) };
  }

  async loginWithOAuth(oauthUser: {
    email: string;
    name: string;
    avatar?: string;
    provider: string;
    providerId: string;
  }) {
    if (!oauthUser.email) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.usersService.findOrCreateOAuthUser(oauthUser);

    if (user.isBlocked) {
      return { user: { isBlocked: true } };
    }

    const tokens = await this.generateUserTokens(user._id.toString(), user.email);
    await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);

    return { ...tokens, user: this.sanitizeUser(user) };
  }

  async refreshUserToken(userId: string, refreshToken: string) {
    const valid = await this.usersService.verifyRefreshToken(userId, refreshToken);
    if (!valid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.generateUserTokens(userId, user.email);
    await this.usersService.updateRefreshToken(userId, tokens.refreshToken);
    return tokens;
  }

  async logoutUser(userId: string) {
    await this.usersService.updateRefreshToken(userId, null);
    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'LOGOUT',
      module: 'auth',
    });
  }

  // ─── Staff Auth ─────────────────────────────────────────────────────────────

  async staffLogin(dto: StaffLoginDto) {
    const staff = await this.staffService.findByEmailOrPhone(dto.identifier);
    if (!staff) throw new UnauthorizedException('Invalid credentials');

    const passwordMatch = await bcrypt.compare(dto.password, staff.password);
    if (!passwordMatch) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateStaffTokens(
      staff._id.toString(),
      staff.email,
      staff.role,
    );
    await this.staffService.updateRefreshToken(staff._id.toString(), tokens.refreshToken);

    await this.auditService.log({
      actorId: staff._id.toString(),
      actorType: 'staff',
      action: 'LOGIN',
      module: 'auth',
    });

    return { ...tokens, staff: { id: staff._id, email: staff.email, name: staff.name, role: staff.role } };
  }

  async refreshStaffToken(staffId: string, refreshToken: string) {
    const valid = await this.staffService.verifyRefreshToken(staffId, refreshToken);
    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    const staff = await this.staffService.findById(staffId);
    if (!staff) throw new UnauthorizedException('Staff not found');

    const tokens = await this.generateStaffTokens(staffId, staff.email, staff.role);
    await this.staffService.updateRefreshToken(staffId, tokens.refreshToken);
    return tokens;
  }

  async logoutStaff(staffId: string) {
    await this.staffService.updateRefreshToken(staffId, null);
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'LOGOUT',
      module: 'auth',
    });
  }

  // ─── Token helpers ──────────────────────────────────────────────────────────

  private async generateUserTokens(userId: string, email: string) {
    const payload = { sub: userId, email, type: 'user' };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
      }),
    ]);
    return { accessToken, refreshToken };
  }

  private async generateStaffTokens(staffId: string, email: string, role: string) {
    const payload = { sub: staffId, email, type: 'staff', role };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
      }),
    ]);
    return { accessToken, refreshToken };
  }

  // Reset password
  async requestPasswordReset(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Don't reveal if email exists
      return { message: 'If the email exists, a reset link will be sent' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600 * 1000); // 1 hour
    await this.usersService.setResetPasswordToken(user._id.toString(), token, expires);

    // TODO: send email with token
    // await this.mailService.sendPasswordReset(user.email, token);

    return { message: 'If the email exists, a reset link will be sent' };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.usersService.findByResetToken(token);
    if (!user) throw new BadRequestException('Invalid or expired reset token');

    await this.usersService.updatePassword(user._id.toString(), newPassword);
    return { message: 'Password reset successfully' };
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return this.sanitizeUser(user);
  }

  private sanitizeUser(user: any) {
    const { password, refreshToken, resetPasswordToken, resetPasswordExpires, ...safe } =
      user.toObject ? user.toObject() : user;
    return safe;
  }
}
