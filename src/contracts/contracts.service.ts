import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import {
  Contract,
  ContractDocument,
  ContractStatus,
  DEFAULT_PAYMENT_SCHEDULE,
  PaymentInstallment,
} from './schemas/contract.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  ExternalRevenue,
  ExternalRevenueDocument,
  ExternalSource,
} from '../external-revenue/schemas/external-revenue.schema';
import { UsersService } from '../users/users.service';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';
import {
  ContractItemDto,
  CreateContractDto,
  PaymentInstallmentDto,
  PublicUpdateDto,
  PublicVerifyDto,
  UpdateContractDto,
  UpdateContractStatusDto,
} from './dto/contract.dto';

/** Bên B mặc định — thông tin cửa hàng */
const DEFAULT_PARTY_B = {
  name: 'Luxe Glow',
  address: '315/3 Vườn Lài, Phú Thọ Hòa, TP. Hồ Chí Minh',
  representative: 'Quách Phương Thanh Trúc',
  position: 'Giám đốc',
  phone: '0909064680',
  email: 'trucquach0506@gmail.com',
  taxCode: '079197022908', // tạm thời, sẽ cập nhật sau
};

/** Thông tin thanh toán cố định (Điều 3.3) */
const BANK_INFO = {
  bankAccountNumber: '060346849013',
  bankName: 'SACOMBANK',
  bankAccountHolder: 'HO KINH DOANH LUXE GLOW',
};

/** Không dùng ký tự dễ nhầm lẫn (0/O, 1/I) */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECURITY_CODE_LENGTH = 8;
const MAX_UNLOCK_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/** Các trạng thái admin còn được chỉnh sửa nội dung */
const EDITABLE_STATUSES = [
  ContractStatus.NEW,
  ContractStatus.REVIEW,
  ContractStatus.DRAFT,
];

/** Bảng chuyển trạng thái hợp lệ */
const STATUS_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  [ContractStatus.NEW]: [ContractStatus.REVIEW, ContractStatus.CLOSED],
  [ContractStatus.REVIEW]: [
    ContractStatus.NEW, // trả lại cho khách bổ sung thông tin
    ContractStatus.DRAFT,
    ContractStatus.FINAL,
    ContractStatus.CLOSED,
  ],
  [ContractStatus.DRAFT]: [
    ContractStatus.REVIEW,
    ContractStatus.FINAL,
    ContractStatus.CLOSED,
  ],
  [ContractStatus.FINAL]: [ContractStatus.SUCCESS, ContractStatus.CLOSED],
  [ContractStatus.SUCCESS]: [],
  [ContractStatus.CLOSED]: [],
};

@Injectable()
export class ContractsService {
  constructor(
    @InjectModel(Contract.name)
    private readonly contractModel: Model<ContractDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ExternalRevenue.name)
    private readonly externalRevenueModel: Model<ExternalRevenueDocument>,
    private readonly usersService: UsersService,
    private readonly staffService: StaffService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private normalizePhone(phone: string): string {
    return phone.startsWith('+84') ? '0' + phone.slice(3) : phone;
  }

  private maskPhone(phone: string): string {
    if (phone.length < 7) return phone;
    return phone.slice(0, 3) + '****' + phone.slice(-3);
  }

  private genSecurityCode(): string {
    let code = '';
    for (let i = 0; i < SECURITY_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    return code;
  }

  private publicUrl(accessToken: string): string {
    const base = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    return `${base.replace(/\/$/, '')}/contract/${accessToken}`;
  }

  /** Số HĐ ngẫu nhiên (không tuần tự — tránh lộ số lượng hợp đồng), VD: 483920/HĐ-2026 */
  private genContractNo(): string {
    const year = new Date().getFullYear();
    const num = crypto.randomInt(0, 1_000_000);
    return `${String(num).padStart(6, '0')}/HĐ-${year}`;
  }

  private async buildItems(itemDtos: ContractItemDto[]) {
    const ids = itemDtos.map((i) => i.productId);
    const products = await this.productModel
      .find({ _id: { $in: ids } })
      .select('name costPrice finalPrice')
      .lean()
      .exec();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const items = itemDtos.map((dto) => {
      const product = productMap.get(dto.productId);
      if (!product) {
        throw new BadRequestException(`Sản phẩm không tồn tại: ${dto.productId}`);
      }
      const unitPrice = dto.unitPrice ?? product.finalPrice;
      return {
        productId: dto.productId,
        productCode: dto.productId.slice(-6).toUpperCase(),
        productName: product.name,
        quantity: dto.quantity,
        unitPrice,
        subtotal: unitPrice * dto.quantity,
        costPrice: product.costPrice ?? 0,
      };
    });

    const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);
    return { items, totalAmount };
  }

  /** Điều 3.2 — tổng % các đợt thanh toán phải đúng 100 */
  private validatePaymentSchedule(schedule: PaymentInstallmentDto[]): void {
    const sum = schedule.reduce((s, i) => s + i.percent, 0);
    if (Math.round(sum * 100) / 100 !== 100) {
      throw new BadRequestException('Tổng % các đợt thanh toán phải bằng 100%');
    }
  }

  /** Loại bỏ dữ liệu nội bộ trước khi trả về phía user */
  private sanitizeForUser(doc: ContractDocument) {
    const c = doc.toObject();
    return {
      contractNo: c.contractNo,
      status: c.status,
      items: c.items.map(({ costPrice: _cost, ...rest }: any) => rest),
      totalAmount: c.totalAmount,
      partyA: c.partyA,
      partyB: c.partyB,
      signPlace: c.signPlace,
      signDate: c.signDate,
      technicalRequirements: c.technicalRequirements,
      paymentSchedule: c.paymentSchedule,
      bankAccountNumber: c.bankAccountNumber,
      bankName: c.bankName,
      bankAccountHolder: c.bankAccountHolder,
      deliveryDate: c.deliveryDate,
      deliveryAddress: c.deliveryAddress,
      userNote: c.userNote,
      closeReason: c.closeReason,
      submittedAt: c.submittedAt,
      finalizedAt: c.finalizedAt,
      successAt: c.successAt,
      closedAt: c.closedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private toAdminResponse(doc: ContractDocument) {
    const c = doc.toObject();
    delete (c as any).securityCode;
    return { ...c, publicUrl: this.publicUrl(c.accessToken) };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async create(dto: CreateContractDto, staffId: string) {
    const phone = this.normalizePhone(dto.userPhone);
    const { user, created } = await this.usersService.findOrCreateByPhone(
      phone,
      dto.customerName ?? '',
    );

    const { items, totalAmount } = await this.buildItems(dto.items);

    if (dto.paymentSchedule) this.validatePaymentSchedule(dto.paymentSchedule);

    // Prefill Bên A từ tài khoản khách (guest thì bỏ qua email tạm)
    const isGuestEmail = user.email?.endsWith('@guest.luxe-glow.vn');
    const partyA = {
      name: dto.customerName || user.name || '',
      address: '',
      representative: '',
      position: '',
      phone,
      email: isGuestEmail ? '' : user.email ?? '',
      taxCode: '',
    };

    // Retry khi trùng contractNo hoặc accessToken (unique index, cực hiếm — sinh lại mã mới)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const contract = await this.contractModel.create({
          contractNo: this.genContractNo(),
          status: ContractStatus.NEW,
          userId: user._id,
          userPhone: phone,
          accessToken: crypto.randomBytes(24).toString('hex'),
          securityCode: this.genSecurityCode(),
          items,
          totalAmount,
          partyA,
          partyB: { ...DEFAULT_PARTY_B, ...(dto.partyB ?? {}) },
          signPlace: dto.signPlace ?? 'TP. Hồ Chí Minh',
          technicalRequirements: dto.technicalRequirements ?? '',
          deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
          paymentSchedule: dto.paymentSchedule ?? DEFAULT_PAYMENT_SCHEDULE,
          ...BANK_INFO,
          adminNote: dto.adminNote ?? '',
          createdBy: new Types.ObjectId(staffId),
        });

        await this.auditService.log({
          actorId: staffId,
          actorType: 'staff',
          action: 'CONTRACT_CREATE',
          module: 'contracts',
          targetId: contract._id.toString(),
          afterData: { contractNo: contract.contractNo, userPhone: phone, totalAmount },
        });

        return { ...this.toAdminResponse(contract), userCreated: created };
      } catch (err: any) {
        if (err?.code !== 11000 || attempt === 2) throw err;
      }
    }
    throw new BadRequestException('Không thể tạo hợp đồng, vui lòng thử lại');
  }

  async findAll(params: {
    page: number;
    limit: number;
    status?: string;
    search?: string;
  }) {
    const { page, limit, status, search } = params;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { contractNo: { $regex: search, $options: 'i' } },
        { userPhone: { $regex: search, $options: 'i' } },
        { 'partyA.name': { $regex: search, $options: 'i' } },
      ];
    }

    const [docs, total] = await Promise.all([
      this.contractModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .exec(),
      this.contractModel.countDocuments({ ...filter, isDeleted: false }),
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
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Hợp đồng không tồn tại');
    const contract = await this.contractModel
      .findById(id)
      .populate('createdBy', 'name email')
      .populate('userId', 'name email phone isGuest')
      .exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    return this.toAdminResponse(contract);
  }

  /** Xem mã bảo mật — yêu cầu xác nhận lại mật khẩu tài khoản admin */
  async revealCode(id: string, staffId: string, password: string) {
    const valid = await this.staffService.verifyPassword(staffId, password);
    if (!valid) throw new UnauthorizedException('Mật khẩu không đúng');

    const contract = await this.contractModel
      .findById(id)
      .select('+securityCode')
      .exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_REVEAL_CODE',
      module: 'contracts',
      targetId: id,
    });

    return { securityCode: contract.securityCode };
  }

  async update(id: string, dto: UpdateContractDto, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (!EDITABLE_STATUSES.includes(contract.status)) {
      throw new BadRequestException(
        'Hợp đồng đã chốt bản chính thức, không thể chỉnh sửa nội dung',
      );
    }

    const before = { status: contract.status, totalAmount: contract.totalAmount };

    if (dto.items) {
      const { items, totalAmount } = await this.buildItems(dto.items);
      contract.items = items as any;
      contract.totalAmount = totalAmount;
    }
    if (dto.partyA) contract.partyA = { ...contract.partyA, ...dto.partyA } as any;
    if (dto.partyB) contract.partyB = { ...contract.partyB, ...dto.partyB } as any;
    if (dto.signPlace !== undefined) contract.signPlace = dto.signPlace;
    if (dto.signDate !== undefined) contract.signDate = new Date(dto.signDate);
    if (dto.technicalRequirements !== undefined) contract.technicalRequirements = dto.technicalRequirements;
    if (dto.deliveryDate !== undefined) contract.deliveryDate = new Date(dto.deliveryDate);
    if (dto.deliveryAddress !== undefined) contract.deliveryAddress = dto.deliveryAddress;
    if (dto.adminNote !== undefined) contract.adminNote = dto.adminNote;
    if (dto.paymentSchedule) {
      this.validatePaymentSchedule(dto.paymentSchedule);
      contract.paymentSchedule = dto.paymentSchedule as any;
    }

    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_UPDATE',
      module: 'contracts',
      targetId: id,
      beforeData: before,
      afterData: { totalAmount: contract.totalAmount },
    });

    return this.toAdminResponse(contract);
  }

  async changeStatus(id: string, dto: UpdateContractStatusDto, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');

    const from = contract.status;
    const to = dto.status;
    if (from === to) throw new BadRequestException('Hợp đồng đã ở trạng thái này');
    if (!STATUS_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(`Không thể chuyển trạng thái từ ${from} sang ${to}`);
    }

    const now = new Date();
    contract.status = to;

    switch (to) {
      case ContractStatus.REVIEW:
        if (!contract.submittedAt) contract.submittedAt = now;
        break;
      case ContractStatus.FINAL:
        contract.finalizedAt = now;
        if (!contract.signDate) contract.signDate = now;
        break;
      case ContractStatus.SUCCESS: {
        contract.successAt = now;
        // Tự động ghi nhận tài chính (doanh thu ngoài — nguồn CONTRACT)
        if (!contract.revenueEntryId) {
          const cost = contract.items.reduce(
            (sum, i) => sum + (i.costPrice ?? 0) * i.quantity,
            0,
          );
          const entry = await this.externalRevenueModel.create({
            source: ExternalSource.CONTRACT,
            note: `Hợp đồng ${contract.contractNo}`,
            month: now.getMonth() + 1,
            year: now.getFullYear(),
            revenue: contract.totalAmount,
            cost,
            platformFee: 0,
            createdBy: new Types.ObjectId(staffId),
          });
          contract.revenueEntryId = entry._id as Types.ObjectId;
        }
        break;
      }
      case ContractStatus.CLOSED:
        contract.closedAt = now;
        contract.closeReason = dto.note ?? '';
        break;
    }

    contract.statusHistory.push({
      from,
      to,
      at: now,
      byType: 'staff',
      byId: staffId,
      note: dto.note ?? '',
    } as any);

    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: `CONTRACT_STATUS_${to}`,
      module: 'contracts',
      targetId: id,
      beforeData: { status: from },
      afterData: { status: to, note: dto.note },
    });

    return this.toAdminResponse(contract);
  }

  async remove(id: string, staffId: string): Promise<void> {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (![ContractStatus.NEW, ContractStatus.CLOSED].includes(contract.status)) {
      throw new BadRequestException('Chỉ xóa được hợp đồng ở trạng thái Mới tạo hoặc Đã hủy');
    }

    contract.isDeleted = true;
    contract.deletedAt = new Date();
    contract.deletedBy = staffId;
    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_DELETE',
      module: 'contracts',
      targetId: id,
      beforeData: { contractNo: contract.contractNo, status: contract.status },
    });
  }

  // ─── Public (khách truy cập qua link bảo mật) ───────────────────────────────

  async getPublicMeta(token: string) {
    const contract = await this.contractModel.findOne({ accessToken: token }).exec();
    if (!contract) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    return {
      contractNo: contract.contractNo,
      status: contract.status,
      maskedPhone: this.maskPhone(contract.userPhone),
      companyName: contract.partyB?.name || DEFAULT_PARTY_B.name,
    };
  }

  async verifyAccess(token: string, dto: PublicVerifyDto) {
    const contract = await this.contractModel
      .findOne({ accessToken: token })
      .select('+securityCode')
      .exec();
    if (!contract) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');

    if (contract.lockedUntil && contract.lockedUntil > new Date()) {
      const minutes = Math.ceil((contract.lockedUntil.getTime() - Date.now()) / 60000);
      throw new ForbiddenException(
        `Nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút`,
      );
    }

    const phoneOk = this.normalizePhone(dto.phone) === contract.userPhone;
    const codeOk =
      dto.securityCode.replace(/\s/g, '').toUpperCase() === contract.securityCode;

    if (!phoneOk || !codeOk) {
      contract.unlockAttempts += 1;
      if (contract.unlockAttempts >= MAX_UNLOCK_ATTEMPTS) {
        contract.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        contract.unlockAttempts = 0;
      }
      await contract.save();
      throw new UnauthorizedException('Số điện thoại hoặc mã bảo mật không đúng');
    }

    if (contract.unlockAttempts > 0 || contract.lockedUntil) {
      contract.unlockAttempts = 0;
      contract.lockedUntil = undefined;
      await contract.save();
    }

    const accessJwt = await this.jwtService.signAsync(
      { sub: contract._id.toString(), typ: 'contract-access' },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: '4h',
      },
    );

    return { accessJwt, contract: this.sanitizeForUser(contract) };
  }

  /** Xác thực JWT truy cập hợp đồng, trả về document nếu hợp lệ */
  private async resolveAuthorized(token: string, jwt?: string): Promise<ContractDocument> {
    if (!jwt) throw new UnauthorizedException('Vui lòng xác thực để xem hợp đồng');

    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwtService.verifyAsync(jwt, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Phiên đã hết hạn, vui lòng xác thực lại');
    }
    if (payload.typ !== 'contract-access') {
      throw new UnauthorizedException('Phiên không hợp lệ');
    }

    const contract = await this.contractModel.findOne({ accessToken: token }).exec();
    if (!contract) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    if (payload.sub !== contract._id.toString()) {
      throw new UnauthorizedException('Phiên không hợp lệ');
    }
    return contract;
  }

  async getPublicContract(token: string, jwt?: string) {
    const contract = await this.resolveAuthorized(token, jwt);
    return this.sanitizeForUser(contract);
  }

  async publicUpdate(token: string, jwt: string | undefined, dto: PublicUpdateDto) {
    const contract = await this.resolveAuthorized(token, jwt);
    if (contract.status !== ContractStatus.NEW) {
      throw new BadRequestException(
        'Hợp đồng đã được gửi đi, không thể chỉnh sửa. Liên hệ cửa hàng nếu cần thay đổi.',
      );
    }

    if (dto.partyA) contract.partyA = { ...contract.partyA, ...dto.partyA } as any;
    if (dto.deliveryAddress !== undefined) contract.deliveryAddress = dto.deliveryAddress;
    if (dto.userNote !== undefined) contract.userNote = dto.userNote;
    await contract.save();

    return this.sanitizeForUser(contract);
  }

  async publicSubmit(token: string, jwt?: string) {
    const contract = await this.resolveAuthorized(token, jwt);
    if (contract.status !== ContractStatus.NEW) {
      throw new BadRequestException('Hợp đồng đã được gửi đi trước đó');
    }

    const { name, address, phone } = contract.partyA ?? ({} as any);
    if (!name?.trim() || !address?.trim() || !phone?.trim()) {
      throw new BadRequestException(
        'Vui lòng điền đầy đủ Tên, Địa chỉ và Số điện thoại của Bên A trước khi gửi',
      );
    }

    const now = new Date();
    contract.status = ContractStatus.REVIEW;
    contract.submittedAt = now;
    contract.statusHistory.push({
      from: ContractStatus.NEW,
      to: ContractStatus.REVIEW,
      at: now,
      byType: 'user',
      byId: contract.userId?.toString() ?? '',
      note: 'Khách hàng gửi yêu cầu',
    } as any);
    await contract.save();

    await this.auditService.log({
      actorId: contract.userId?.toString() ?? 'unknown',
      actorType: 'user',
      action: 'CONTRACT_SUBMIT',
      module: 'contracts',
      targetId: contract._id.toString(),
    });

    return this.sanitizeForUser(contract);
  }
}
