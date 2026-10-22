import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
  ContractSource,
  ContractStatus,
  ContractTemplate,
  PartySignatureStatus,
  PaymentInfoType,
  PaymentInstallment,
  SignatureMode,
  TEMPLATE_PAYMENT_SCHEDULES,
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
import { PdfGenerationService } from '../document-signing/pdf-generation/pdf-generation.service';
import { ContractPdfInput } from '../document-signing/pdf-generation/contract-pdf.definition';
import { DocumentStorageService } from '../document-signing/storage/document-storage.service';
import { PadesVerifyService } from '../document-signing/pades/pades-verify.service';
import { TamperCheckService } from '../document-signing/pades/tamper-check.service';
import { PdfInspectService } from '../document-signing/pdfjs/pdf-inspect.service';
import {
  ContractItemDto,
  CreateContractDto,
  ImportContractDto,
  PaymentInstallmentDto,
  PublicUpdateDto,
  PublicVerifyDto,
  RejectSignatureDto,
  SubmitSimpleSignatureDto,
  UpdateContractDto,
  UpdateContractStatusDto,
  UpdateImportedContractDto,
} from './dto/contract.dto';

/** File PDF admin tải lên khi import hợp đồng */
export interface ImportedPdfFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** Bên B mặc định — thông tin cửa hàng */
const DEFAULT_PARTY_B = {
  name: 'Luxe Glow',
  address: '315/3 Vườn Lài, Phú Thọ Hòa, TP. Hồ Chí Minh',
  representative: 'Quách Phương Thanh Trúc',
  position: 'Giám đốc',
  phone: '0909064680',
  email: 'support@luxe-glow.vn',
  taxCode: '079197022908', // tạm thời, sẽ cập nhật sau
};

/** Thông tin thanh toán (Điều 3.3) — admin chọn Công ty hoặc Cá nhân, giá trị mỗi bộ cố định */
const BANK_INFO_PRESETS: Record<
  PaymentInfoType,
  { bankAccountNumber: string; bankName: string; bankAccountHolder: string }
> = {
  [PaymentInfoType.COMPANY]: {
    bankAccountNumber: '680446431',
    bankName: 'VPBANK',
    bankAccountHolder: 'HO KINH DOANH LUXE GLOW',
  },
  [PaymentInfoType.INDIVIDUAL]: {
    bankAccountNumber: '0909064680',
    bankName: 'VIETINBANK',
    bankAccountHolder: 'QUACH PHUONG THANH TRUC',
  },
};

/** Địa điểm giao hàng mặc định của dự án JOYLOVE (Điều 4.2) — prefill khi tạo, khách vẫn sửa được */
const JOYLOVE_DELIVERY_ADDRESS =
  'Kho Flash, Công ty BW Industrial, Đường D2, KCN Tân Phú Trung, Củ Chi, Thành phố Hồ Chí Minh. Số điện thoại nhận hàng: 0987928827';

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

/**
 * Hợp đồng import: nội dung đã cố định trong file PDF nên không có bước khách điền Bên A
 * (NEW/REVIEW). Tạo ra ở DRAFT (admin còn sửa metadata / thay file), FINAL khoá file để ký số.
 */
const IMPORTED_STATUS_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  [ContractStatus.NEW]: [],
  [ContractStatus.REVIEW]: [],
  [ContractStatus.DRAFT]: [ContractStatus.FINAL, ContractStatus.CLOSED],
  [ContractStatus.FINAL]: [ContractStatus.SUCCESS, ContractStatus.CLOSED],
  [ContractStatus.SUCCESS]: [],
  [ContractStatus.CLOSED]: [],
};

/** Hợp đồng import được xoá khi chưa chốt (DRAFT) hoặc đã hủy */
const IMPORTED_DELETABLE_STATUSES = [ContractStatus.DRAFT, ContractStatus.CLOSED];

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

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
    private readonly pdfGenerationService: PdfGenerationService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly padesVerifyService: PadesVerifyService,
    private readonly tamperCheckService: TamperCheckService,
    private readonly pdfInspectService: PdfInspectService,
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

  private isImported(contract: { source?: ContractSource }): boolean {
    return contract.source === ContractSource.IMPORTED;
  }

  /**
   * Số HĐ do admin nhập tay (HĐ import) — kiểm tra trùng cả với hợp đồng đã xoá mềm vì unique
   * index trên contractNo không phân biệt isDeleted.
   */
  private async assertContractNoAvailable(contractNo: string, excludeId?: Types.ObjectId): Promise<void> {
    const filter: Record<string, unknown> = { contractNo, isDeleted: { $in: [true, false] } };
    if (excludeId) filter._id = { $ne: excludeId };
    const exists = await this.contractModel.exists(filter);
    if (exists) throw new BadRequestException(`Số hợp đồng "${contractNo}" đã tồn tại`);
  }

  /** Multer giải mã tên file multipart theo latin1 — đổi lại UTF-8 để giữ đúng tên tiếng Việt */
  private decodeFileName(name: string): string {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    const safe = decoded.includes('\uFFFD') ? name : decoded;
    return safe.replace(/[\\/\r\n]/g, '_').slice(0, 255) || 'hop-dong.pdf';
  }

  /** Kiểm tra + lưu file PDF import làm "PDF chính tắc" (unsignedPdfUrl) của hợp đồng */
  private async storeImportedPdf(contractId: Types.ObjectId, file: ImportedPdfFile, staffId: string) {
    const inspection = await this.pdfInspectService.inspect(file.buffer);
    const stored = await this.documentStorageService.uploadPdf(
      file.buffer,
      `${contractId.toString()}/unsigned`,
    );
    return {
      stored,
      importedDocument: {
        originalFileName: this.decodeFileName(file.originalname),
        fileSize: file.size,
        pageCount: inspection.pageCount,
        hasTextLayer: inspection.hasTextLayer,
        sha256: inspection.sha256,
        uploadedAt: new Date(),
        uploadedBy: staffId,
      },
    };
  }

  /** Điều 3.2 — số đợt phải khớp template, tổng % các đợt thanh toán phải đúng 100 */
  private validatePaymentSchedule(schedule: PaymentInstallmentDto[], template: ContractTemplate): void {
    const expected = TEMPLATE_PAYMENT_SCHEDULES[template].length;
    if (schedule.length !== expected) {
      throw new BadRequestException(`Lịch thanh toán của mẫu hợp đồng này phải có đúng ${expected} đợt`);
    }
    const sum = schedule.reduce((s, i) => s + i.percent, 0);
    if (Math.round(sum * 100) / 100 !== 100) {
      throw new BadRequestException('Tổng % các đợt thanh toán phải bằng 100%');
    }
  }

  /**
   * Tên hiển thị tại mục ký "ĐẠI DIỆN BÊN A (Ký, ghi rõ họ tên)" của văn bản hợp đồng
   * (xem ContractDocument.tsx) — ưu tiên representative, fallback name.
   */
  private partyASignerName(partyA?: { name?: string; representative?: string }): string {
    return partyA?.representative?.trim() || partyA?.name?.trim() || '';
  }

  /**
   * Bắt buộc Bên A phải có họ và tên đầy đủ (tối thiểu 2 từ, VD: "Nguyễn Văn A") trước khi
   * hợp đồng được gửi duyệt / chốt chính thức — tránh trường hợp chỉ điền một từ (tên, không
   * có họ) hoặc tên placeholder bị in vào phần chữ ký.
   */
  private assertPartyAFullName(partyA?: { name?: string; representative?: string }): void {
    const signer = this.partyASignerName(partyA);
    const wordCount = signer.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2) {
      throw new BadRequestException(
        'Vui lòng điền đầy đủ họ và tên của Bên A (VD: Nguyễn Văn A), không chỉ một từ, để hiển thị đúng tại mục ký tên hợp đồng',
      );
    }
  }

  /**
   * Sinh PDF hợp đồng chưa ký và lưu vào Cloudinary — CHỈ gọi khi contract.unsignedPdfUrl
   * chưa tồn tại (regenerate sau khi đã có chữ ký sẽ làm mất hiệu lực chữ ký số đã ký).
   */
  private async generateAndStoreUnsignedPdf(contract: ContractDocument): Promise<void> {
    const input: ContractPdfInput = {
      template: contract.template ?? ContractTemplate.DEFAULT,
      contractNo: contract.contractNo,
      createdAt: contract.createdAt,
      items: contract.items.map((i) => ({
        productCode: i.productCode,
        productName: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
      })),
      totalAmount: contract.totalAmount,
      partyA: contract.partyA,
      partyB: contract.partyB,
      signPlace: contract.signPlace,
      signDate: contract.signDate,
      technicalRequirements: contract.technicalRequirements,
      paymentSchedule: contract.paymentSchedule,
      bankAccountNumber: contract.bankAccountNumber,
      bankName: contract.bankName,
      bankAccountHolder: contract.bankAccountHolder,
      deliveryDate: contract.deliveryDate,
      deliveryAddress: contract.deliveryAddress,
    };
    const buffer = await this.pdfGenerationService.generateContractPdf(input);
    const stored = await this.documentStorageService.uploadPdf(
      buffer,
      `${contract._id.toString()}/unsigned`,
    );
    contract.unsignedPdfUrl = stored.url;
    contract.unsignedPdfPublicId = stored.publicId;
    contract.unsignedPdfGeneratedAt = new Date();
  }

  /** Loại bỏ dữ liệu nội bộ trước khi trả về phía user */
  private sanitizeForUser(doc: ContractDocument) {
    const c = doc.toObject();
    return {
      contractNo: c.contractNo,
      status: c.status,
      source: c.source ?? ContractSource.TEMPLATE,
      template: c.template ?? ContractTemplate.DEFAULT,
      title: c.title,
      offlineSigned: c.offlineSigned,
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
      unsignedPdfUrl: c.unsignedPdfUrl,
      partyBSignature: c.partyBSignature && {
        status: c.partyBSignature.status,
        signerCertCN: c.partyBSignature.signerCertCN,
        signingTime: c.partyBSignature.signingTime,
        verifiedAt: c.partyBSignature.verifiedAt,
      },
      partyASignature: c.partyASignature && {
        status: c.partyASignature.status,
        mode: c.partyASignature.mode,
        signerCertCN: c.partyASignature.signerCertCN,
        signerCertIssuer: c.partyASignature.signerCertIssuer,
        signingTime: c.partyASignature.signingTime,
        verifiedAt: c.partyASignature.verifiedAt,
        rejectReason: c.partyASignature.rejectReason,
        simpleSignature: c.partyASignature.simpleSignature && {
          canvasImageUrl: c.partyASignature.simpleSignature.canvasImageUrl,
          confirmedName: c.partyASignature.simpleSignature.confirmedName,
          confirmedAt: c.partyASignature.simpleSignature.confirmedAt,
        },
      },
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

    const template = dto.template ?? ContractTemplate.DEFAULT;
    if (dto.paymentSchedule) this.validatePaymentSchedule(dto.paymentSchedule, template);

    const paymentInfoType = dto.paymentInfoType ?? PaymentInfoType.COMPANY;

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
          template,
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
          paymentSchedule: dto.paymentSchedule ?? TEMPLATE_PAYMENT_SCHEDULES[template],
          deliveryAddress: template === ContractTemplate.JOYLOVE_ADVANCE ? JOYLOVE_DELIVERY_ADDRESS : '',
          paymentInfoType,
          ...BANK_INFO_PRESETS[paymentInfoType],
          adminNote: dto.adminNote ?? '',
          createdBy: new Types.ObjectId(staffId),
        });

        await this.auditService.log({
          actorId: staffId,
          actorType: 'staff',
          action: 'CONTRACT_CREATE',
          module: 'contracts',
          targetId: contract._id.toString(),
          afterData: { contractNo: contract.contractNo, userPhone: phone, totalAmount, template },
        });

        return { ...this.toAdminResponse(contract), userCreated: created };
      } catch (err: any) {
        if (err?.code !== 11000 || attempt === 2) throw err;
      }
    }
    throw new BadRequestException('Không thể tạo hợp đồng, vui lòng thử lại');
  }

  /**
   * Import hợp đồng soạn ngoài hệ thống từ file PDF. File được lưu làm PDF chính tắc
   * (unsignedPdfUrl) nên luồng ký số Bên B / Bên A và tamper-check dùng lại nguyên vẹn.
   * Hợp đồng tạo ra ở trạng thái DRAFT — admin kiểm tra rồi chốt FINAL.
   */
  async importContract(dto: ImportContractDto, file: ImportedPdfFile, staffId: string) {
    const phone = this.normalizePhone(dto.userPhone);
    const customContractNo = dto.contractNo?.trim();
    if (customContractNo) await this.assertContractNoAvailable(customContractNo);

    const { user, created } = await this.usersService.findOrCreateByPhone(phone, dto.customerName.trim());

    const contractId = new Types.ObjectId();
    const { stored, importedDocument } = await this.storeImportedPdf(contractId, file, staffId);

    const isGuestEmail = user.email?.endsWith('@guest.luxe-glow.vn');
    const partyA = {
      address: '',
      representative: '',
      position: '',
      taxCode: '',
      ...(dto.partyA ?? {}),
      name: dto.partyA?.name?.trim() || dto.customerName.trim(),
      phone: dto.partyA?.phone?.trim() || phone,
      email: dto.partyA?.email?.trim() || (isGuestEmail ? '' : user.email ?? ''),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const contract = await this.contractModel.create({
          _id: contractId,
          contractNo: customContractNo || this.genContractNo(),
          status: ContractStatus.DRAFT,
          source: ContractSource.IMPORTED,
          title: dto.title?.trim() ?? '',
          userId: user._id,
          userPhone: phone,
          accessToken: crypto.randomBytes(24).toString('hex'),
          securityCode: this.genSecurityCode(),
          items: [],
          totalAmount: dto.totalAmount,
          importedCostAmount: dto.costAmount ?? 0,
          partyA,
          partyB: { ...DEFAULT_PARTY_B },
          signDate: dto.signDate ? new Date(dto.signDate) : undefined,
          deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
          adminNote: dto.adminNote ?? '',
          offlineSigned: dto.offlineSigned ?? false,
          unsignedPdfUrl: stored.url,
          unsignedPdfPublicId: stored.publicId,
          unsignedPdfGeneratedAt: importedDocument.uploadedAt,
          importedDocument,
          createdBy: new Types.ObjectId(staffId),
        });

        await this.auditService.log({
          actorId: staffId,
          actorType: 'staff',
          action: 'CONTRACT_IMPORT',
          module: 'contracts',
          targetId: contract._id.toString(),
          afterData: {
            contractNo: contract.contractNo,
            userPhone: phone,
            totalAmount: dto.totalAmount,
            fileName: importedDocument.originalFileName,
            sha256: importedDocument.sha256,
          },
        });

        return { ...this.toAdminResponse(contract), userCreated: created };
      } catch (err: any) {
        // Trùng số HĐ do admin nhập (race) thì không thử lại — chỉ sinh lại khi số HĐ tự sinh / token trùng
        const retryable = err?.code === 11000 && !(customContractNo && err?.keyPattern?.contractNo);
        if (!retryable || attempt === 2) {
          await this.documentStorageService.deleteRaw(stored.publicId);
          if (err?.code === 11000 && err?.keyPattern?.contractNo) {
            throw new BadRequestException(`Số hợp đồng "${customContractNo}" đã tồn tại`);
          }
          throw err;
        }
      }
    }
    throw new BadRequestException('Không thể import hợp đồng, vui lòng thử lại');
  }

  /**
   * Sửa metadata hợp đồng import. DRAFT: sửa được mọi trường. FINAL: chỉ còn ghi chú nội bộ và
   * cờ "đã ký ngoài hệ thống" (VD: chốt bản PDF, gửi khách ký tay, sau đó admin xác nhận).
   */
  async updateImported(id: string, dto: UpdateImportedContractDto, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (!this.isImported(contract)) {
      throw new BadRequestException('Chỉ áp dụng cho hợp đồng import từ file PDF');
    }

    const isDraft = contract.status === ContractStatus.DRAFT;
    if (!isDraft && contract.status !== ContractStatus.FINAL) {
      throw new BadRequestException('Hợp đồng đã hoàn tất hoặc đã hủy, không thể chỉnh sửa');
    }
    const finalOnlyFields: (keyof UpdateImportedContractDto)[] = ['adminNote', 'offlineSigned'];
    if (!isDraft) {
      const locked = (Object.keys(dto) as (keyof UpdateImportedContractDto)[]).filter(
        (k) => dto[k] !== undefined && !finalOnlyFields.includes(k),
      );
      if (locked.length > 0) {
        throw new BadRequestException(
          'Hợp đồng đã chốt bản chính thức — chỉ còn sửa được ghi chú nội bộ và xác nhận đã ký ngoài hệ thống',
        );
      }
    }

    const before = {
      contractNo: contract.contractNo,
      totalAmount: contract.totalAmount,
      offlineSigned: contract.offlineSigned,
    };

    if (dto.contractNo !== undefined) {
      const no = dto.contractNo.trim();
      if (!no) throw new BadRequestException('Số hợp đồng không được để trống');
      if (no !== contract.contractNo) {
        await this.assertContractNoAvailable(no, contract._id);
        contract.contractNo = no;
      }
    }
    if (dto.title !== undefined) contract.title = dto.title.trim();
    if (dto.totalAmount !== undefined) contract.totalAmount = dto.totalAmount;
    if (dto.costAmount !== undefined) contract.importedCostAmount = dto.costAmount;
    if (dto.partyA) {
      // partyA là subdocument — spread trực tiếp không lấy được field, phải toObject() trước
      const merged = { ...(contract.toObject().partyA ?? {}), ...dto.partyA };
      if (!merged.name?.trim()) throw new BadRequestException('Tên Bên A không được để trống');
      contract.partyA = merged;
    }
    if (dto.signDate !== undefined) contract.signDate = new Date(dto.signDate);
    if (dto.deliveryDate !== undefined) contract.deliveryDate = new Date(dto.deliveryDate);
    if (dto.adminNote !== undefined) contract.adminNote = dto.adminNote;
    if (dto.offlineSigned !== undefined) contract.offlineSigned = dto.offlineSigned;

    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_IMPORT_UPDATE',
      module: 'contracts',
      targetId: id,
      beforeData: before,
      afterData: {
        contractNo: contract.contractNo,
        totalAmount: contract.totalAmount,
        offlineSigned: contract.offlineSigned,
      },
    });

    return this.toAdminResponse(contract);
  }

  /** Thay file PDF của hợp đồng import — chỉ khi còn DRAFT (chưa ai ký trên file cũ) */
  async replaceImportedFile(id: string, file: ImportedPdfFile, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (!this.isImported(contract)) {
      throw new BadRequestException('Chỉ áp dụng cho hợp đồng import từ file PDF');
    }
    if (contract.status !== ContractStatus.DRAFT) {
      throw new BadRequestException('Chỉ thay được file khi hợp đồng còn ở trạng thái Bản nháp');
    }
    const signed = [contract.partyBSignature?.status, contract.partyASignature?.status].some(
      (st) => st && st !== PartySignatureStatus.PENDING,
    );
    if (signed) {
      throw new BadRequestException('Hợp đồng đã phát sinh chữ ký trên file hiện tại, không thể thay file');
    }

    const previous = contract.importedDocument;
    const { stored, importedDocument } = await this.storeImportedPdf(contract._id, file, staffId);
    contract.unsignedPdfUrl = stored.url;
    contract.unsignedPdfPublicId = stored.publicId;
    contract.unsignedPdfGeneratedAt = importedDocument.uploadedAt;
    contract.importedDocument = importedDocument as any;
    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_IMPORT_REPLACE_FILE',
      module: 'contracts',
      targetId: id,
      beforeData: previous ? { fileName: previous.originalFileName, sha256: previous.sha256 } : undefined,
      afterData: { fileName: importedDocument.originalFileName, sha256: importedDocument.sha256 },
    });

    return this.toAdminResponse(contract);
  }

  async findAll(params: {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    source?: string;
  }) {
    const { page, limit, status, search, source } = params;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (source === ContractSource.IMPORTED) filter.source = ContractSource.IMPORTED;
    // HĐ cũ (trước khi có field source) chưa có giá trị — coi như TEMPLATE
    if (source === ContractSource.TEMPLATE) filter.source = { $ne: ContractSource.IMPORTED };
    if (search) {
      filter.$or = [
        { contractNo: { $regex: search, $options: 'i' } },
        { userPhone: { $regex: search, $options: 'i' } },
        { 'partyA.name': { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
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
    if (this.isImported(contract)) {
      throw new BadRequestException(
        'Hợp đồng import từ file PDF không dùng template — sửa thông tin hoặc thay file PDF thay vì chỉnh nội dung',
      );
    }
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
    if (dto.template && dto.template !== (contract.template ?? ContractTemplate.DEFAULT)) {
      contract.template = dto.template;
      // Số đợt thanh toán khác nhau giữa các template — không kèm lịch mới thì dùng lịch mặc định
      if (!dto.paymentSchedule) contract.paymentSchedule = TEMPLATE_PAYMENT_SCHEDULES[dto.template] as any;
    }
    if (dto.paymentSchedule) {
      this.validatePaymentSchedule(dto.paymentSchedule, contract.template ?? ContractTemplate.DEFAULT);
      contract.paymentSchedule = dto.paymentSchedule as any;
    }
    if (dto.paymentInfoType) {
      contract.paymentInfoType = dto.paymentInfoType;
      Object.assign(contract, BANK_INFO_PRESETS[dto.paymentInfoType]);
    }

    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_UPDATE',
      module: 'contracts',
      targetId: id,
      beforeData: before,
      afterData: { totalAmount: contract.totalAmount, template: contract.template },
    });

    return this.toAdminResponse(contract);
  }

  async changeStatus(id: string, dto: UpdateContractStatusDto, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');

    const from = contract.status;
    const to = dto.status;
    if (from === to) throw new BadRequestException('Hợp đồng đã ở trạng thái này');
    const imported = this.isImported(contract);
    const transitions = imported ? IMPORTED_STATUS_TRANSITIONS : STATUS_TRANSITIONS;
    if (!transitions[from].includes(to)) {
      throw new BadRequestException(`Không thể chuyển trạng thái từ ${from} sang ${to}`);
    }
    // HĐ import: tên ký đã in sẵn trong file PDF, không phụ thuộc dữ liệu Bên A trên hệ thống
    if (!imported && (to === ContractStatus.REVIEW || to === ContractStatus.FINAL)) {
      this.assertPartyAFullName(contract.partyA);
    }
    if (imported && to === ContractStatus.FINAL && !contract.unsignedPdfUrl) {
      throw new BadRequestException('Hợp đồng import chưa có file PDF');
    }
    const signedOffline = imported && contract.offlineSigned;
    if (
      to === ContractStatus.SUCCESS &&
      !signedOffline &&
      contract.partyBSignature?.status !== PartySignatureStatus.VERIFIED
    ) {
      throw new BadRequestException(
        imported
          ? 'Hợp đồng cần được Bên B ký số (đã xác thực), hoặc xác nhận "Đã ký ngoài hệ thống", trước khi chuyển sang Hoàn tất'
          : 'Hợp đồng cần được Bên B ký số (đã xác thực) trước khi chuyển sang Hoàn tất',
      );
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
        if (!contract.unsignedPdfUrl) {
          try {
            await this.generateAndStoreUnsignedPdf(contract);
          } catch (err) {
            // Không chặn việc chốt hợp đồng — admin có thể tạo lại PDF thủ công qua endpoint /document/generate
            this.logger.error(
              `Sinh PDF chưa ký thất bại cho hợp đồng ${contract._id.toString()}: ${(err as Error).message}`,
            );
          }
        }
        break;
      case ContractStatus.SUCCESS: {
        contract.successAt = now;
        // Tự động ghi nhận tài chính (doanh thu ngoài — nguồn CONTRACT)
        if (!contract.revenueEntryId) {
          const cost =
            contract.items.reduce((sum, i) => sum + (i.costPrice ?? 0) * i.quantity, 0) +
            (contract.importedCostAmount ?? 0);
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
    if (this.isImported(contract)) {
      if (!IMPORTED_DELETABLE_STATUSES.includes(contract.status)) {
        throw new BadRequestException('Chỉ xóa được hợp đồng import ở trạng thái Bản nháp hoặc Đã hủy');
      }
    } else if (![ContractStatus.NEW, ContractStatus.CLOSED].includes(contract.status)) {
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

  // ─── Tài liệu & Ký số (PAdES) ────────────────────────────────────────────────

  /** Trạng thái ký số tóm tắt — dùng cho panel "Tài liệu & Ký số" ở admin */
  async getDocumentStatus(id: string) {
    const contract = await this.contractModel
      .findById(id)
      .select('contractNo status unsignedPdfUrl unsignedPdfGeneratedAt partyBSignature partyASignature')
      .exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    return {
      contractNo: contract.contractNo,
      status: contract.status,
      unsignedPdfUrl: contract.unsignedPdfUrl,
      unsignedPdfGeneratedAt: contract.unsignedPdfGeneratedAt,
      partyBSignature: contract.partyBSignature,
      partyASignature: contract.partyASignature,
    };
  }

  /** Tạo lại PDF chưa ký thủ công — fallback khi auto-gen lúc chuyển FINAL bị lỗi */
  async generateDocument(id: string, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (this.isImported(contract)) {
      throw new BadRequestException('Hợp đồng import đã có sẵn file PDF, không tạo từ template');
    }
    if (EDITABLE_STATUSES.includes(contract.status)) {
      throw new BadRequestException('Hợp đồng chưa chốt bản chính thức, chưa thể tạo PDF');
    }
    if (contract.unsignedPdfUrl) {
      throw new BadRequestException(
        'PDF chưa ký đã được tạo trước đó — không thể tạo lại (sẽ làm mất hiệu lực chữ ký số nếu đã có)',
      );
    }

    await this.generateAndStoreUnsignedPdf(contract);
    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_DOCUMENT_GENERATE',
      module: 'contracts',
      targetId: id,
    });

    return this.toAdminResponse(contract);
  }

  async getUnsignedPdfBuffer(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.contractModel
      .findById(id)
      .select('unsignedPdfUrl contractNo source')
      .exec();
    if (!contract?.unsignedPdfUrl) throw new NotFoundException('Chưa có file PDF chưa ký cho hợp đồng này');
    const buffer = await this.documentStorageService.downloadPdf(contract.unsignedPdfUrl);
    const suffix = this.isImported(contract) ? 'ban-import' : 'chua-ky';
    return { buffer, filename: `hop-dong-${contract.contractNo.replace(/\//g, '-')}-${suffix}.pdf` };
  }

  async getPartyBSignedPdfBuffer(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.contractModel.findById(id).select('partyBSignature contractNo').exec();
    if (!contract?.partyBSignature?.signedPdfUrl) {
      throw new NotFoundException('Hợp đồng chưa có file đã ký Bên B');
    }
    const buffer = await this.documentStorageService.downloadPdf(contract.partyBSignature.signedPdfUrl);
    return { buffer, filename: `hop-dong-${contract.contractNo.replace(/\//g, '-')}-da-ky-ben-b.pdf` };
  }

  /**
   * Admin upload PDF đã ký bởi Bên B (ký ngoài hệ thống bằng phần mềm ký số riêng trên máy có
   * cắm USB token). Xác thực: (1) file là bản nối thêm từ đúng PDF chưa ký hệ thống đã tạo —
   * không bị chỉnh sửa nội dung, (2) chữ ký PAdES/CMS nhúng trong file hợp lệ về mặt mật mã.
   * KHÔNG xác minh chuỗi CA gốc — xem PartyBSignature.chainValidated.
   */
  async uploadPartyBSigned(id: string, fileBuffer: Buffer, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    // HĐ import đã có PDF ngay từ DRAFT — chỉ cho ký khi file đã khoá (FINAL), tránh ký rồi thay file
    if (EDITABLE_STATUSES.includes(contract.status)) {
      throw new BadRequestException('Hợp đồng chưa chốt bản chính thức, chưa thể ký');
    }
    if (!contract.unsignedPdfUrl) {
      throw new BadRequestException('Chưa có PDF chưa ký để đối chiếu — vui lòng tạo PDF trước');
    }
    if (contract.partyBSignature?.status === PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Hợp đồng đã có chữ ký Bên B hợp lệ, không thể ghi đè');
    }

    const unsignedBuffer = await this.documentStorageService.downloadPdf(contract.unsignedPdfUrl);
    await this.tamperCheckService.assertIncrementalOnly(unsignedBuffer, fileBuffer);

    const signatures = this.padesVerifyService.verify(fileBuffer);
    if (signatures.length === 0) {
      throw new BadRequestException('Không tìm thấy chữ ký số hợp lệ trong file tải lên');
    }
    const sig = signatures[signatures.length - 1];
    if (!sig.coversToEndOfFile || !sig.digestValid || !sig.signatureValid) {
      contract.partyBSignature = {
        ...(contract.partyBSignature as any),
        status: PartySignatureStatus.REJECTED,
        rejectReason: 'Chữ ký số không hợp lệ (digest hoặc chữ ký không khớp)',
        uploadedAt: new Date(),
        uploadedBy: staffId,
      } as any;
      await contract.save();
      throw new BadRequestException(
        'Chữ ký số trong file không hợp lệ — vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung',
      );
    }

    const stored = await this.documentStorageService.uploadPdf(
      fileBuffer,
      `${contract._id.toString()}/party-b-signed`,
    );
    const now = new Date();
    contract.partyBSignature = {
      status: PartySignatureStatus.VERIFIED,
      signedPdfUrl: stored.url,
      signedPdfPublicId: stored.publicId,
      signerCertCN: sig.signerCertCN,
      signerCertSerial: sig.signerCertSerial,
      signerCertIssuer: sig.signerCertIssuer,
      certNotBefore: sig.certNotBefore,
      certNotAfter: sig.certNotAfter,
      signingTime: sig.signingTime,
      uploadedAt: now,
      verifiedAt: now,
      chainValidated: false,
      rejectReason: '',
      uploadedBy: staffId,
    } as any;
    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_PARTY_B_SIGNED',
      module: 'contracts',
      targetId: id,
      afterData: {
        signerCertCN: sig.signerCertCN,
        signerCertIssuer: sig.signerCertIssuer,
        signingTime: sig.signingTime,
      },
    });

    return this.toAdminResponse(contract);
  }

  /**
   * Admin từ chối chữ ký Bên A đã VERIFIED về mặt mật mã nhưng chứng thư không đáng tin cậy
   * (chain review thủ công — hệ thống không tự động xác minh chuỗi CA gốc).
   */
  async rejectPartyASignature(id: string, dto: RejectSignatureDto, staffId: string) {
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    if (contract.partyASignature?.status !== PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Hợp đồng chưa có chữ ký Bên A hợp lệ để từ chối');
    }

    contract.partyASignature.status = PartySignatureStatus.REJECTED;
    contract.partyASignature.rejectReason = dto.reason;
    await contract.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'CONTRACT_PARTY_A_SIGNATURE_REJECT',
      module: 'contracts',
      targetId: id,
      afterData: { reason: dto.reason },
    });

    return this.toAdminResponse(contract);
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
    this.assertPartyAFullName(contract.partyA);

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

  // ─── Public — Tài liệu & Ký số Bên A ─────────────────────────────────────────

  /** Trạng thái ký số public-safe — dùng để hiển thị tiến trình trên trang khách */
  async getPublicDocumentStatus(token: string, jwt?: string) {
    const contract = await this.resolveAuthorized(token, jwt);
    const sanitized = this.sanitizeForUser(contract);
    return {
      status: sanitized.status,
      unsignedPdfUrl: sanitized.unsignedPdfUrl,
      partyBSignature: sanitized.partyBSignature,
      partyASignature: sanitized.partyASignature,
    };
  }

  /**
   * PDF để khách xem văn bản hợp đồng (HĐ import không dựng được HTML từ template) — trả bản
   * mới nhất: đã ký Bên A (PKI) > đã ký Bên B > bản gốc.
   */
  async getPublicDocumentView(token: string, jwt?: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.resolveAuthorized(token, jwt);
    const a = contract.partyASignature;
    const b = contract.partyBSignature;
    const url =
      (a?.status === PartySignatureStatus.VERIFIED && a.mode === SignatureMode.PKI && a.signedPdfUrl) ||
      (b?.status === PartySignatureStatus.VERIFIED && b.signedPdfUrl) ||
      contract.unsignedPdfUrl;
    if (!url) throw new NotFoundException('Hợp đồng chưa có file PDF');
    const buffer = await this.documentStorageService.downloadPdf(url);
    return { buffer, filename: `hop-dong-${contract.contractNo.replace(/\//g, '-')}.pdf` };
  }

  /** PDF khách cần tải về để ký chồng lên (luôn là bản đã có chữ ký Bên B) */
  async getDocumentToSign(token: string, jwt?: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.resolveAuthorized(token, jwt);
    if (contract.partyBSignature?.status !== PartySignatureStatus.VERIFIED || !contract.partyBSignature.signedPdfUrl) {
      throw new BadRequestException('Hợp đồng chưa được Bên B ký, chưa thể ký');
    }
    const buffer = await this.documentStorageService.downloadPdf(contract.partyBSignature.signedPdfUrl);
    return { buffer, filename: `hop-dong-${contract.contractNo.replace(/\//g, '-')}-can-ky.pdf` };
  }

  /**
   * Khách upload PDF đã ký chồng chữ ký số của mình (Bên A) lên trên bản đã có chữ ký Bên B —
   * ký ngoài hệ thống bằng phần mềm ký số riêng trên máy có cắm USB token, giống hệt luồng Bên B.
   */
  async uploadPartyASigned(token: string, jwt: string | undefined, fileBuffer: Buffer) {
    const contract = await this.resolveAuthorized(token, jwt);
    if (contract.partyBSignature?.status !== PartySignatureStatus.VERIFIED || !contract.partyBSignature.signedPdfUrl) {
      throw new BadRequestException('Hợp đồng chưa được Bên B ký, chưa thể ký');
    }
    if (contract.partyASignature?.status === PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Hợp đồng đã có chữ ký hợp lệ của Bên A, không thể ghi đè');
    }

    const partyBBuffer = await this.documentStorageService.downloadPdf(contract.partyBSignature.signedPdfUrl);
    await this.tamperCheckService.assertIncrementalOnly(partyBBuffer, fileBuffer);

    const signatures = this.padesVerifyService.verify(fileBuffer);
    if (signatures.length < 2) {
      throw new BadRequestException(
        'Không tìm thấy chữ ký số của bạn trong file tải lên — vui lòng ký chồng lên đúng file đã tải từ hệ thống (đã có sẵn chữ ký Bên B)',
      );
    }
    const sig = signatures[signatures.length - 1];
    if (!sig.coversToEndOfFile || !sig.digestValid || !sig.signatureValid) {
      contract.partyASignature = {
        ...(contract.partyASignature as any),
        status: PartySignatureStatus.REJECTED,
        mode: SignatureMode.PKI,
        rejectReason: 'Chữ ký số không hợp lệ (digest hoặc chữ ký không khớp)',
        uploadedAt: new Date(),
      } as any;
      await contract.save();
      throw new BadRequestException(
        'Chữ ký số trong file không hợp lệ — vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung',
      );
    }

    const stored = await this.documentStorageService.uploadPdf(
      fileBuffer,
      `${contract._id.toString()}/party-a-signed`,
    );
    const now = new Date();
    contract.partyASignature = {
      status: PartySignatureStatus.VERIFIED,
      mode: SignatureMode.PKI,
      signedPdfUrl: stored.url,
      signedPdfPublicId: stored.publicId,
      signerCertCN: sig.signerCertCN,
      signerCertSerial: sig.signerCertSerial,
      signerCertIssuer: sig.signerCertIssuer,
      certNotBefore: sig.certNotBefore,
      certNotAfter: sig.certNotAfter,
      signingTime: sig.signingTime,
      chainValidated: false,
      uploadedAt: now,
      verifiedAt: now,
      rejectReason: '',
    } as any;
    await contract.save();

    await this.auditService.log({
      actorId: contract.userId?.toString() ?? 'unknown',
      actorType: 'user',
      action: 'CONTRACT_PARTY_A_SIGNED_PKI',
      module: 'contracts',
      targetId: contract._id.toString(),
      afterData: { signerCertCN: sig.signerCertCN, signerCertIssuer: sig.signerCertIssuer },
    });

    return this.sanitizeForUser(contract);
  }

  /**
   * Chữ ký điện tử đơn giản (canvas vẽ tay) — fallback cho khách không có chữ ký số thật.
   * KHÔNG đụng vào file PDF đã ký Bên B (sẽ phá vỡ chữ ký số thật đó) — chỉ lưu 1 bản ghi
   * xác nhận riêng (ảnh + tên + IP + thời điểm + hash toàn vẹn).
   */
  async submitPartyASimpleSignature(
    token: string,
    jwt: string | undefined,
    dto: SubmitSimpleSignatureDto,
    ip: string,
    userAgent: string,
  ) {
    const contract = await this.resolveAuthorized(token, jwt);
    if (contract.partyBSignature?.status !== PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Hợp đồng chưa được Bên B ký, chưa thể ký');
    }
    if (contract.partyASignature?.status === PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Hợp đồng đã có chữ ký của Bên A, không thể ghi đè');
    }

    const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(dto.canvasImageBase64.trim());
    if (!match) {
      throw new BadRequestException('Ảnh chữ ký không hợp lệ (cần định dạng PNG)');
    }
    const imageBuffer = Buffer.from(match[1], 'base64');
    if (imageBuffer.length === 0 || imageBuffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Ảnh chữ ký không hợp lệ hoặc quá lớn');
    }

    const canvasImageUrl = await this.documentStorageService.uploadSignatureImage(
      imageBuffer,
      `${contract._id.toString()}/party-a-simple-signature`,
    );

    const now = new Date();
    const integrityHash = crypto
      .createHash('sha256')
      .update(`${canvasImageUrl}|${dto.confirmedName}|${contract._id.toString()}|${now.toISOString()}`)
      .digest('hex');

    contract.partyASignature = {
      status: PartySignatureStatus.VERIFIED,
      mode: SignatureMode.SIMPLE,
      simpleSignature: {
        canvasImageUrl,
        confirmedName: dto.confirmedName,
        ipAddress: ip,
        userAgent,
        confirmedAt: now,
        integrityHash,
      },
      chainValidated: false,
      uploadedAt: now,
      verifiedAt: now,
      rejectReason: '',
    } as any;
    await contract.save();

    await this.auditService.log({
      actorId: contract.userId?.toString() ?? 'unknown',
      actorType: 'user',
      action: 'CONTRACT_PARTY_A_SIGNED_SIMPLE',
      module: 'contracts',
      targetId: contract._id.toString(),
      afterData: { confirmedName: dto.confirmedName, ip },
    });

    return {
      ...this.sanitizeForUser(contract),
      legalNote:
        'Đây là chữ ký điện tử đơn giản để xác nhận nội dung hợp đồng, KHÔNG phải chữ ký số (chữ ký điện tử an toàn) theo Nghị định 130/2018.',
    };
  }
}
