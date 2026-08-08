import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { NfcProfile, NfcProfileDocument } from './schemas/nfc-profile.schema';
import { AuditService } from '../audit/audit.service';
import {
  AdminCreateNfcDto,
  PublicActivateDto,
  PublicLoginDto,
  SaveSocialLinksDto,
  SocialLinkDto,
} from './dto/nfc.dto';
import { validateLinkValue } from './constants/social-icons.constant';

/** Không dùng ký tự dễ nhầm lẫn (0/O, 1/I) — giống contracts.service.ts */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NFC_CODE_LENGTH = 8;
const NFC_ID_SUFFIX_LENGTH = 6;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class NfcService {
  constructor(
    @InjectModel(NfcProfile.name) private readonly nfcModel: Model<NfcProfileDocument>,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private normalizePhone(phone: string): string {
    return phone.startsWith('+84') ? '0' + phone.slice(3) : phone;
  }

  private genRandomCode(length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    return code;
  }

  private genNfcId(): string {
    return `NFC-${this.genRandomCode(NFC_ID_SUFFIX_LENGTH)}`;
  }

  private frontendBase(): string {
    return this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, '');
  }

  private publicUrl(nfcCode: string): string {
    return `${this.frontendBase()}/nfc/${nfcCode}`;
  }

  private manageUrl(nfcId: string): string {
    return `${this.frontendBase()}/nfc/${nfcId}`;
  }

  private async signAccessJwt(sub: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub, typ: 'nfc-access' },
      { secret: this.configService.get<string>('JWT_SECRET'), expiresIn: '30d' },
    );
  }

  private assertValidLinks(links: SocialLinkDto[]): void {
    for (const link of links) {
      const err = validateLinkValue(link.icon, link.value);
      if (err) throw new BadRequestException(`${link.icon}: ${err}`);
    }
  }

  /** Loại bỏ dữ liệu nội bộ trước khi trả về phía admin */
  private toAdminResponse(doc: NfcProfileDocument) {
    const p: any = doc.toObject();
    delete p.password;
    return {
      ...p,
      socialLinksCount: p.socialLinks?.length ?? 0,
      publicUrl: this.publicUrl(p.nfcCode),
      manageUrl: this.manageUrl(p.nfcId),
    };
  }

  /** Loại bỏ dữ liệu nhạy cảm trước khi trả về phía chủ thẻ (owner) */
  private sanitizeForOwner(doc: NfcProfileDocument) {
    const p: any = doc.toObject();
    return {
      _id: p._id,
      nfcId: p.nfcId,
      nfcCode: p.nfcCode,
      phone: p.phone,
      isActivated: p.isActivated,
      socialLinks: p.socialLinks,
      createdAt: p.createdAt,
    };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async create(dto: AdminCreateNfcDto, staffId: string) {
    const customNfcId = dto.nfcId?.trim();
    if (customNfcId) {
      const existing = await this.nfcModel.findOne({ nfcId: customNfcId }).exec();
      if (existing) throw new ConflictException('NFC_ID này đã tồn tại');
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const profile = await this.nfcModel.create({
          nfcId: customNfcId || this.genNfcId(),
          nfcCode: this.genRandomCode(NFC_CODE_LENGTH),
          createdBy: new Types.ObjectId(staffId),
        });

        await this.auditService.log({
          actorId: staffId,
          actorType: 'staff',
          action: 'NFC_CREATE',
          module: 'nfc',
          targetId: profile._id.toString(),
          afterData: { nfcId: profile.nfcId, nfcCode: profile.nfcCode },
        });

        return this.toAdminResponse(profile);
      } catch (err: any) {
        if (err?.code !== 11000 || attempt === 2) {
          if (err?.code === 11000) {
            throw new ConflictException('Không thể tạo thẻ NFC do trùng mã, vui lòng thử lại');
          }
          throw err;
        }
        // Va chạm trùng nfcCode (hiếm) — thử lại với nfcCode mới, giữ nguyên nfcId nếu admin đã chỉ định
      }
    }
    throw new BadRequestException('Không thể tạo thẻ NFC, vui lòng thử lại');
  }

  async findAll(params: {
    page: number;
    limit: number;
    search?: string;
    isActivated?: string;
    isActive?: string;
  }) {
    const { page, limit, search, isActivated, isActive } = params;
    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { nfcId: { $regex: search, $options: 'i' } },
        { nfcCode: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    if (isActivated !== undefined) filter.isActivated = isActivated === 'true';
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const [docs, total] = await Promise.all([
      this.nfcModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      // countDocuments bypasses the pre(/^find/) isDeleted middleware (only `find*` hooks apply) — filter explicitly
      this.nfcModel.countDocuments({ ...filter, isDeleted: false }).exec(),
    ]);

    return {
      data: docs.map((d) => this.toAdminResponse(d)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Không tìm thấy thẻ NFC');
    const profile = await this.nfcModel.findById(id).populate('createdBy', 'name email').exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    return this.toAdminResponse(profile);
  }

  async toggleActive(id: string, staffId: string) {
    const profile = await this.nfcModel.findById(id).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    profile.isActive = !profile.isActive;
    await profile.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'NFC_TOGGLE_ACTIVE',
      module: 'nfc',
      targetId: id,
      afterData: { isActive: profile.isActive },
    });

    return this.toAdminResponse(profile);
  }

  async updateSocialLinksAdmin(id: string, dto: SaveSocialLinksDto, staffId: string) {
    const profile = await this.nfcModel.findById(id).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    this.assertValidLinks(dto.links);
    profile.socialLinks = dto.links as any;
    await profile.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'NFC_ADMIN_LINKS_UPDATE',
      module: 'nfc',
      targetId: id,
      afterData: { linksCount: dto.links.length },
    });

    return this.toAdminResponse(profile);
  }

  async resetActivation(id: string, staffId: string) {
    const profile = await this.nfcModel.findById(id).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');

    await this.nfcModel
      .findByIdAndUpdate(id, {
        $set: { isActivated: false, socialLinks: [], loginAttempts: 0 },
        $unset: { phone: '', password: '', termsAcceptedAt: '', lockedUntil: '' },
      })
      .exec();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'NFC_RESET_ACTIVATION',
      module: 'nfc',
      targetId: id,
      beforeData: { phone: profile.phone },
    });

    return this.findById(id);
  }

  async softDelete(id: string, staffId: string): Promise<void> {
    const profile = await this.nfcModel.findById(id).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');

    profile.isDeleted = true;
    profile.deletedAt = new Date();
    profile.deletedBy = staffId;
    await profile.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'NFC_DELETE',
      module: 'nfc',
      targetId: id,
      beforeData: { nfcId: profile.nfcId, nfcCode: profile.nfcCode },
    });
  }

  // ─── Public ─────────────────────────────────────────────────────────────────

  /** Xác định `code` trong URL là NFC_ID (trang quản lý) hay NFC_CODE (trang xem công khai) */
  async resolveMeta(code: string) {
    const byId = await this.nfcModel.findOne({ nfcId: code }).exec();
    if (byId) {
      return { kind: 'manage' as const, isActivated: byId.isActivated, disabled: !byId.isActive };
    }
    const byCode = await this.nfcModel.findOne({ nfcCode: code }).exec();
    if (byCode) {
      return { kind: 'view' as const, disabled: !byCode.isActive || !byCode.isActivated };
    }
    throw new NotFoundException('Không tìm thấy thẻ NFC — liên kết không hợp lệ');
  }

  async activate(nfcId: string, dto: PublicActivateDto) {
    const profile = await this.nfcModel.findOne({ nfcId }).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    if (!profile.isActive) throw new ForbiddenException('Thẻ NFC này đã bị vô hiệu hoá');
    if (profile.isActivated) {
      throw new BadRequestException('Thẻ đã được kích hoạt trước đó, vui lòng đăng nhập');
    }
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    profile.phone = this.normalizePhone(dto.phone);
    profile.password = await bcrypt.hash(dto.password, 12);
    profile.isActivated = true;
    profile.termsAcceptedAt = new Date();
    await profile.save();

    await this.auditService.log({
      actorId: profile._id.toString(),
      actorType: 'user',
      action: 'NFC_ACTIVATE',
      module: 'nfc',
      targetId: profile._id.toString(),
    });

    const accessJwt = await this.signAccessJwt(profile._id.toString());
    return { accessJwt, profile: this.sanitizeForOwner(profile) };
  }

  async login(nfcId: string, dto: PublicLoginDto) {
    const profile = await this.nfcModel.findOne({ nfcId }).select('+password').exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    if (!profile.isActive) throw new ForbiddenException('Thẻ NFC này đã bị vô hiệu hoá');
    if (!profile.isActivated) throw new BadRequestException('Thẻ chưa được kích hoạt');

    if (profile.lockedUntil && profile.lockedUntil > new Date()) {
      const minutes = Math.ceil((profile.lockedUntil.getTime() - Date.now()) / 60000);
      throw new ForbiddenException(`Nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút`);
    }

    const phoneOk = this.normalizePhone(dto.phone) === profile.phone;
    const passOk = profile.password ? await bcrypt.compare(dto.password, profile.password) : false;

    if (!phoneOk || !passOk) {
      profile.loginAttempts += 1;
      if (profile.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        profile.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        profile.loginAttempts = 0;
      }
      await profile.save();
      throw new UnauthorizedException('Số điện thoại hoặc mật khẩu không đúng');
    }

    if (profile.loginAttempts > 0 || profile.lockedUntil) {
      profile.loginAttempts = 0;
      profile.lockedUntil = undefined;
      await profile.save();
    }

    await this.auditService.log({
      actorId: profile._id.toString(),
      actorType: 'user',
      action: 'NFC_LOGIN',
      module: 'nfc',
      targetId: profile._id.toString(),
    });

    const accessJwt = await this.signAccessJwt(profile._id.toString());
    return { accessJwt, profile: this.sanitizeForOwner(profile) };
  }

  /** Xác thực JWT truy cập thẻ NFC, trả về document nếu hợp lệ */
  private async resolveAuthorized(nfcId: string, jwt?: string): Promise<NfcProfileDocument> {
    if (!jwt) throw new UnauthorizedException('Vui lòng đăng nhập để tiếp tục');

    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwtService.verifyAsync(jwt, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Phiên đã hết hạn, vui lòng đăng nhập lại');
    }
    if (payload.typ !== 'nfc-access') {
      throw new UnauthorizedException('Phiên không hợp lệ');
    }

    const profile = await this.nfcModel.findOne({ nfcId }).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    if (payload.sub !== profile._id.toString()) {
      throw new UnauthorizedException('Phiên không hợp lệ');
    }
    if (!profile.isActive) throw new ForbiddenException('Thẻ NFC này đã bị vô hiệu hoá');
    // Admin có thể reset-activation (xoá phone/password) mà không đổi _id — JWT cũ phải
    // hết hiệu lực ngay khi đó, không chỉ dựa vào việc verify chữ ký còn hạn.
    if (!profile.isActivated) {
      throw new UnauthorizedException('Thẻ đã được đặt lại, vui lòng kích hoạt lại');
    }
    return profile;
  }

  async getOwnProfile(nfcId: string, jwt?: string) {
    const profile = await this.resolveAuthorized(nfcId, jwt);
    return this.sanitizeForOwner(profile);
  }

  async saveSocialLinks(nfcId: string, jwt: string | undefined, dto: SaveSocialLinksDto) {
    const profile = await this.resolveAuthorized(nfcId, jwt);
    this.assertValidLinks(dto.links);
    profile.socialLinks = dto.links as any;
    await profile.save();
    return this.sanitizeForOwner(profile);
  }

  /** Trang xem công khai — chỉ trả về các link, không lộ SĐT/nfcId */
  async getPublicView(code: string) {
    const profile = await this.nfcModel.findOne({ nfcCode: code }).exec();
    if (!profile) throw new NotFoundException('Không tìm thấy thẻ NFC');
    if (!profile.isActive || !profile.isActivated) {
      throw new NotFoundException('Thẻ NFC chưa sẵn sàng để xem');
    }
    return {
      socialLinks: profile.socialLinks.map((l) => ({ _id: l._id, icon: l.icon, value: l.value })),
    };
  }
}
