import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import {
  ADDENDUM_NO_START,
  AddendumStatus,
  Contract,
  ContractAddendum,
  ContractDocument,
  ContractSource,
  ContractStatus,
  ContractTemplate,
  DEFAULT_ADDENDUM_PAYMENT_SCHEDULE,
  PartySignMethod,
  PartySignatureStatus,
  SignatureMode,
} from './schemas/contract.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { ContractsService } from './contracts.service';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';
import { PdfGenerationService } from '../document-signing/pdf-generation/pdf-generation.service';
import { AddendumPdfInput, addendumLabel } from '../document-signing/pdf-generation/addendum-pdf.definition';
import { DocumentStorageService } from '../document-signing/storage/document-storage.service';
import { PadesVerifyService } from '../document-signing/pades/pades-verify.service';
import { TamperCheckService } from '../document-signing/pades/tamper-check.service';
import { PadesSignService } from '../document-signing/pades/pades-sign.service';
import { SignaturePlacementService } from '../document-signing/pades/signature-placement.service';
import { SigningCredentialsService } from '../document-signing/pades/signing-credentials.service';
import { assertCertificateUsable, loadPkcs12, SignerCredentials } from '../document-signing/pades/pkcs12';
import {
  AddendumItemDto,
  CancelAddendumDto,
  CreateAddendumDto,
  PaymentInstallmentDto,
  RejectSignatureDto,
  SignCertSource,
  SignContractDto,
  SubmitSimpleSignatureDto,
  UpdateAddendumDto,
} from './dto/contract.dto';

type AddendumDoc = ContractAddendum & { _id: Types.ObjectId };

/** Tên loại hợp đồng in ở phần "Căn cứ" của phụ lục */
const CONTRACT_NAME = 'Hợp đồng thiết kế và sản xuất sản phẩm in 3D';

/**
 * Phụ lục hợp đồng — sửa đổi, bổ sung (mua thêm, gia công thêm…) cho hợp đồng đã chốt bản chính
 * thức (FINAL) mà không phải lập hợp đồng mới. Mỗi phụ lục có PDF chính tắc riêng, ký số Bên B
 * (trên hệ thống hoặc ký ngoài rồi tải lên) và Bên A (PKI hoặc ký đơn giản) độc lập với hợp đồng.
 *
 * Giá trị phụ lục FINAL được cộng vào Contract.addendaAmount (tổng thanh toán = totalAmount +
 * addendaAmount); văn bản hợp đồng gốc không đổi.
 */
@Injectable()
export class ContractAddendaService {
  private readonly logger = new Logger(ContractAddendaService.name);

  constructor(
    @InjectModel(Contract.name)
    private readonly contractModel: Model<ContractDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly contractsService: ContractsService,
    private readonly staffService: StaffService,
    private readonly auditService: AuditService,
    private readonly pdfGenerationService: PdfGenerationService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly padesVerifyService: PadesVerifyService,
    private readonly tamperCheckService: TamperCheckService,
    private readonly padesSignService: PadesSignService,
    private readonly signaturePlacementService: SignaturePlacementService,
    private readonly signingCredentialsService: SigningCredentialsService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async loadContract(id: string): Promise<ContractDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Hợp đồng không tồn tại');
    const contract = await this.contractModel.findById(id).exec();
    if (!contract) throw new NotFoundException('Hợp đồng không tồn tại');
    return contract;
  }

  private findAddendum(contract: ContractDocument, addendumId: string): AddendumDoc {
    const addendum = Types.ObjectId.isValid(addendumId)
      ? (contract.addenda ?? []).find((a) => a._id.toString() === addendumId)
      : undefined;
    if (!addendum) throw new NotFoundException('Phụ lục không tồn tại');
    return addendum as AddendumDoc;
  }

  /** Lập / sửa / chốt / hủy phụ lục chỉ khi hợp đồng đã chốt chính thức và chưa hoàn tất */
  private assertContractAcceptsAddenda(contract: ContractDocument): void {
    if (contract.status !== ContractStatus.FINAL) {
      throw new BadRequestException(
        contract.status === ContractStatus.SUCCESS || contract.status === ContractStatus.CLOSED
          ? 'Hợp đồng đã hoàn tất hoặc đã hủy, không thể lập / thay đổi phụ lục'
          : 'Hợp đồng chưa chốt bản chính thức — hãy chỉnh sửa trực tiếp nội dung hợp đồng thay vì lập phụ lục',
      );
    }
  }

  private assertDraft(addendum: AddendumDoc): void {
    if (addendum.status !== AddendumStatus.DRAFT) {
      throw new BadRequestException('Phụ lục đã chốt hoặc đã hủy, không thể chỉnh sửa');
    }
  }

  private label(addendum: { addendumNo: number }): string {
    return addendumLabel(addendum.addendumNo);
  }

  private storagePrefix(contract: ContractDocument, addendum: AddendumDoc): string {
    return `${contract._id.toString()}/addendum-${String(addendum.addendumNo).padStart(2, '0')}`;
  }

  private fileBase(contract: ContractDocument, addendum: AddendumDoc): string {
    return `phu-luc-${String(addendum.addendumNo).padStart(2, '0')}-hop-dong-${contract.contractNo.replace(/\//g, '-')}`;
  }

  private nextAddendumNo(contract: ContractDocument): number {
    const used = (contract.addenda ?? []).map((a) => a.addendumNo);
    if (used.length > 0) return Math.max(...used) + 1;
    const template = contract.template ?? ContractTemplate.DEFAULT;
    return contract.source === ContractSource.IMPORTED ? 1 : ADDENDUM_NO_START[template] ?? 1;
  }

  /** Tổng giá trị phụ lục đã chốt — gọi lại sau mỗi thay đổi trạng thái/giá trị phụ lục */
  private recalcAddendaAmount(contract: ContractDocument): void {
    contract.addendaAmount = (contract.addenda ?? [])
      .filter((a) => a.status === AddendumStatus.FINAL)
      .reduce((s, a) => s + (a.amount ?? 0), 0);
  }

  private async buildItems(dtos: AddendumItemDto[]) {
    const ids = dtos.map((d) => d.productId).filter((id): id is string => !!id);
    const products = ids.length
      ? await this.productModel.find({ _id: { $in: ids } }).select('name costPrice finalPrice').lean().exec()
      : [];
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const items = dtos.map((dto) => {
      if (dto.productId) {
        const product = productMap.get(dto.productId);
        if (!product) throw new BadRequestException(`Sản phẩm không tồn tại: ${dto.productId}`);
        const unitPrice = dto.unitPrice ?? product.finalPrice;
        return {
          productId: dto.productId,
          productCode: dto.productId.slice(-6).toUpperCase(),
          productName: dto.productName?.trim() || product.name,
          quantity: dto.quantity,
          unitPrice,
          subtotal: unitPrice * dto.quantity,
          costPrice: product.costPrice ?? 0,
        };
      }
      const name = dto.productName?.trim();
      if (!name) throw new BadRequestException('Vui lòng nhập tên hạng mục bổ sung');
      if (dto.unitPrice === undefined) {
        throw new BadRequestException(`Vui lòng nhập đơn giá cho hạng mục "${name}"`);
      }
      return {
        productId: '',
        productCode: dto.productCode?.trim().toUpperCase() ?? '',
        productName: name,
        quantity: dto.quantity,
        unitPrice: dto.unitPrice,
        subtotal: dto.unitPrice * dto.quantity,
        costPrice: dto.costPrice ?? 0,
      };
    });
    return { items, amount: items.reduce((s, i) => s + i.subtotal, 0) };
  }

  private validateSchedule(schedule: PaymentInstallmentDto[]): void {
    const sum = schedule.reduce((s, i) => s + i.percent, 0);
    if (Math.round(sum * 100) / 100 !== 100) {
      throw new BadRequestException('Tổng % các lần thanh toán phụ lục phải bằng 100%');
    }
  }

  /** Phụ lục phải có nội dung: ít nhất 1 hạng mục bổ sung hoặc nội dung sửa đổi */
  private assertHasContent(addendum: { items: unknown[]; content?: string }): void {
    if ((addendum.items ?? []).length === 0 && !addendum.content?.trim()) {
      throw new BadRequestException('Phụ lục phải có ít nhất 1 hạng mục bổ sung hoặc nội dung sửa đổi, bổ sung');
    }
  }

  private buildPdfInput(contract: ContractDocument, addendum: AddendumDoc, watermark?: string): AddendumPdfInput {
    const c = contract.toObject();
    const a = (c.addenda ?? []).find((x: AddendumDoc) => x._id.toString() === addendum._id.toString()) ?? addendum;
    const previousAddenda = (c.addenda ?? [])
      .filter((x: AddendumDoc) => x.status === AddendumStatus.FINAL && x._id.toString() !== addendum._id.toString())
      .sort((x: AddendumDoc, y: AddendumDoc) => x.addendumNo - y.addendumNo)
      .map((x: AddendumDoc) => ({ addendumNo: x.addendumNo, amount: x.amount }));
    const imported = c.source === ContractSource.IMPORTED;
    return {
      addendumNo: a.addendumNo,
      title: a.title,
      content: a.content,
      contractNo: c.contractNo,
      contractName: imported ? (c.title?.trim() ? `Hợp đồng ${c.title.trim()}` : 'Hợp đồng') : CONTRACT_NAME,
      contractSignDate: c.signDate,
      partyA: c.partyA,
      partyB: c.partyB,
      signPlace: c.signPlace || 'TP. Hồ Chí Minh',
      signDate: a.signDate,
      items: (a.items ?? []).map((i: AddendumDoc['items'][number]) => ({
        productCode: i.productCode,
        productName: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
      })),
      amount: a.amount,
      contractAmount: c.totalAmount,
      previousAddenda,
      paymentSchedule: a.paymentSchedule ?? [],
      bankAccountNumber: c.bankAccountNumber,
      bankName: c.bankName,
      bankAccountHolder: c.bankAccountHolder,
      deliveryDate: a.deliveryDate,
      watermark,
    };
  }

  /** Sinh + lưu PDF chính tắc — CHỈ khi phụ lục chưa có (regenerate làm mất hiệu lực chữ ký số) */
  private async generateAndStoreUnsignedPdf(contract: ContractDocument, addendum: AddendumDoc): Promise<void> {
    const buffer = await this.pdfGenerationService.generateAddendumPdf(this.buildPdfInput(contract, addendum));
    const stored = await this.documentStorageService.uploadPdf(buffer, `${this.storagePrefix(contract, addendum)}/unsigned`);
    addendum.unsignedPdfUrl = stored.url;
    addendum.unsignedPdfPublicId = stored.publicId;
    addendum.unsignedPdfGeneratedAt = new Date();
  }

  private audit(staffId: string, action: string, contract: ContractDocument, addendum: AddendumDoc, data?: Record<string, unknown>) {
    return this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action,
      module: 'contracts',
      targetId: contract._id.toString(),
      afterData: { addendumId: addendum._id.toString(), addendumNo: addendum.addendumNo, ...(data ?? {}) },
    });
  }

  // ─── Admin — soạn phụ lục ───────────────────────────────────────────────────

  async create(contractId: string, dto: CreateAddendumDto, staffId: string) {
    const contract = await this.loadContract(contractId);
    this.assertContractAcceptsAddenda(contract);

    const { items, amount } = await this.buildItems(dto.items ?? []);
    const draft = { items, content: dto.content ?? '' };
    this.assertHasContent(draft);
    const paymentSchedule = dto.paymentSchedule ?? DEFAULT_ADDENDUM_PAYMENT_SCHEDULE;
    if (amount > 0) this.validateSchedule(paymentSchedule);

    contract.addenda.push({
      addendumNo: this.nextAddendumNo(contract),
      status: AddendumStatus.DRAFT,
      title: dto.title?.trim() ?? '',
      content: dto.content?.trim() ?? '',
      items,
      amount,
      paymentSchedule,
      deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
      signDate: dto.signDate ? new Date(dto.signDate) : undefined,
      createdBy: staffId,
    } as never);
    await contract.save();

    const addendum = contract.addenda[contract.addenda.length - 1] as AddendumDoc;
    await this.audit(staffId, 'CONTRACT_ADDENDUM_CREATE', contract, addendum, { amount });
    return this.contractsService.toAdminResponse(contract);
  }

  async update(contractId: string, addendumId: string, dto: UpdateAddendumDto, staffId: string) {
    const contract = await this.loadContract(contractId);
    this.assertContractAcceptsAddenda(contract);
    const addendum = this.findAddendum(contract, addendumId);
    this.assertDraft(addendum);

    if (dto.items) {
      const { items, amount } = await this.buildItems(dto.items);
      addendum.items = items as never;
      addendum.amount = amount;
    }
    if (dto.title !== undefined) addendum.title = dto.title.trim();
    if (dto.content !== undefined) addendum.content = dto.content.trim();
    if (dto.paymentSchedule) addendum.paymentSchedule = dto.paymentSchedule as never;
    if (dto.deliveryDate !== undefined) addendum.deliveryDate = dto.deliveryDate ? new Date(dto.deliveryDate) : undefined;
    if (dto.signDate !== undefined) addendum.signDate = dto.signDate ? new Date(dto.signDate) : undefined;

    this.assertHasContent(addendum);
    if (addendum.amount > 0) {
      if ((addendum.paymentSchedule ?? []).length === 0) addendum.paymentSchedule = DEFAULT_ADDENDUM_PAYMENT_SCHEDULE as never;
      this.validateSchedule(addendum.paymentSchedule);
    }
    await contract.save();

    await this.audit(staffId, 'CONTRACT_ADDENDUM_UPDATE', contract, addendum, { amount: addendum.amount });
    return this.contractsService.toAdminResponse(contract);
  }

  /** Xoá phụ lục bản nháp — phụ lục đã chốt chỉ hủy được (giữ lại lịch sử) */
  async remove(contractId: string, addendumId: string, staffId: string) {
    const contract = await this.loadContract(contractId);
    this.assertContractAcceptsAddenda(contract);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.status !== AddendumStatus.DRAFT) {
      throw new BadRequestException('Chỉ xoá được phụ lục bản nháp — phụ lục đã chốt hãy dùng "Hủy phụ lục"');
    }
    contract.addenda = contract.addenda.filter((a) => a._id.toString() !== addendumId) as never;
    await contract.save();

    await this.audit(staffId, 'CONTRACT_ADDENDUM_DELETE', contract, addendum);
    return this.contractsService.toAdminResponse(contract);
  }

  /** Chốt phụ lục: khoá nội dung, sinh PDF chính tắc, cộng giá trị vào tổng thanh toán */
  async finalize(contractId: string, addendumId: string, staffId: string) {
    const contract = await this.loadContract(contractId);
    this.assertContractAcceptsAddenda(contract);
    const addendum = this.findAddendum(contract, addendumId);
    this.assertDraft(addendum);
    this.assertHasContent(addendum);

    const now = new Date();
    addendum.status = AddendumStatus.FINAL;
    addendum.finalizedAt = now;
    if (!addendum.signDate) addendum.signDate = now;
    this.recalcAddendaAmount(contract);
    try {
      await this.generateAndStoreUnsignedPdf(contract, addendum);
    } catch (err) {
      // Không chặn việc chốt — admin tạo lại PDF qua endpoint /document/generate
      this.logger.error(
        `Sinh PDF ${this.label(addendum)} thất bại cho HĐ ${contract.contractNo}: ${(err as Error).message}`,
      );
    }
    await contract.save();

    await this.audit(staffId, 'CONTRACT_ADDENDUM_FINAL', contract, addendum, {
      amount: addendum.amount,
      addendaAmount: contract.addendaAmount,
    });
    return this.contractsService.toAdminResponse(contract);
  }

  /** Hủy phụ lục đã chốt — giá trị không còn tính vào tổng thanh toán */
  async cancel(contractId: string, addendumId: string, dto: CancelAddendumDto, staffId: string) {
    const contract = await this.loadContract(contractId);
    this.assertContractAcceptsAddenda(contract);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.status !== AddendumStatus.FINAL) {
      throw new BadRequestException(
        addendum.status === AddendumStatus.DRAFT ? 'Phụ lục bản nháp — hãy xoá thay vì hủy' : 'Phụ lục đã bị hủy trước đó',
      );
    }
    addendum.status = AddendumStatus.CANCELLED;
    addendum.cancelledAt = new Date();
    addendum.cancelReason = dto.reason.trim();
    this.recalcAddendaAmount(contract);
    await contract.save();

    await this.audit(staffId, 'CONTRACT_ADDENDUM_CANCEL', contract, addendum, {
      reason: addendum.cancelReason,
      addendaAmount: contract.addendaAmount,
    });
    return this.contractsService.toAdminResponse(contract);
  }

  // ─── Admin — tài liệu & ký số ───────────────────────────────────────────────

  /** PDF xem trước dựng từ dữ liệu hiện tại (bản nháp có chữ chìm) — không lưu lại */
  async previewPdf(contractId: string, addendumId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.status !== AddendumStatus.DRAFT && addendum.unsignedPdfUrl) {
      return this.getUnsignedPdf(contractId, addendumId);
    }
    const watermark = addendum.status === AddendumStatus.CANCELLED ? 'ĐÃ HỦY' : addendum.status === AddendumStatus.DRAFT ? 'BẢN NHÁP' : undefined;
    const buffer = await this.pdfGenerationService.generateAddendumPdf(this.buildPdfInput(contract, addendum, watermark));
    return { buffer, filename: `${this.fileBase(contract, addendum)}-xem-truoc.pdf` };
  }

  async generateDocument(contractId: string, addendumId: string, staffId: string) {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.status !== AddendumStatus.FINAL) {
      throw new BadRequestException('Chỉ tạo PDF cho phụ lục đã chốt');
    }
    if (addendum.unsignedPdfUrl) {
      throw new BadRequestException('PDF phụ lục đã được tạo trước đó — không thể tạo lại (sẽ làm mất hiệu lực chữ ký số nếu đã có)');
    }
    await this.generateAndStoreUnsignedPdf(contract, addendum);
    await contract.save();
    await this.audit(staffId, 'CONTRACT_ADDENDUM_DOCUMENT_GENERATE', contract, addendum);
    return this.contractsService.toAdminResponse(contract);
  }

  async getUnsignedPdf(contractId: string, addendumId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    if (!addendum.unsignedPdfUrl) throw new NotFoundException('Phụ lục chưa có file PDF');
    const buffer = await this.documentStorageService.downloadPdf(addendum.unsignedPdfUrl);
    return { buffer, filename: `${this.fileBase(contract, addendum)}-chua-ky.pdf` };
  }

  /** Bản mới nhất có chữ ký số: Bên A ký PKI chồng lên > Bên B */
  private latestSignedUrl(addendum: AddendumDoc): string | undefined {
    const a = addendum.partyASignature;
    const b = addendum.partyBSignature;
    return (
      (a?.status === PartySignatureStatus.VERIFIED && a.mode === SignatureMode.PKI && a.signedPdfUrl) ||
      (b?.status === PartySignatureStatus.VERIFIED && b.signedPdfUrl) ||
      undefined
    );
  }

  async getSignedPdf(contractId: string, addendumId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    const url = this.latestSignedUrl(addendum);
    if (!url) throw new NotFoundException('Phụ lục chưa có bản PDF đã ký số');
    const buffer = await this.documentStorageService.downloadPdf(url);
    return { buffer, filename: `${this.fileBase(contract, addendum)}-da-ky-so.pdf` };
  }

  private assertPartyBCanSign(contract: ContractDocument, addendum: AddendumDoc): void {
    if (contract.status === ContractStatus.CLOSED) throw new BadRequestException('Hợp đồng đã hủy, không thể ký phụ lục');
    if (addendum.status !== AddendumStatus.FINAL) {
      throw new BadRequestException('Chỉ ký được phụ lục đã chốt (chưa hủy)');
    }
    if (!addendum.unsignedPdfUrl) {
      throw new BadRequestException('Phụ lục chưa có PDF để ký — vui lòng tạo PDF trước');
    }
    if (addendum.partyBSignature?.status === PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Phụ lục đã có chữ ký Bên B hợp lệ, không thể ghi đè');
    }
  }

  /** Bên B tải lên PDF phụ lục đã ký ngoài hệ thống (USB token) */
  async uploadPartyBSigned(contractId: string, addendumId: string, fileBuffer: Buffer, staffId: string) {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    this.assertPartyBCanSign(contract, addendum);
    const unsigned = await this.documentStorageService.downloadPdf(addendum.unsignedPdfUrl!);
    return this.acceptPartyBSignedPdf(contract, addendum, unsigned, fileBuffer, staffId, PartySignMethod.EXTERNAL_UPLOAD);
  }

  /** Bên B ký số trực tiếp trên hệ thống — cùng quy tắc với ký hợp đồng (ContractsService.signPartyBInSystem) */
  async signPartyBInSystem(
    contractId: string,
    addendumId: string,
    dto: SignContractDto,
    certFile: Buffer | undefined,
    staffId: string,
  ) {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    this.assertPartyBCanSign(contract, addendum);

    let credentials: SignerCredentials;
    let method: PartySignMethod;
    if (dto.certSource === SignCertSource.SERVER) {
      if (!dto.staffPassword) {
        throw new BadRequestException('Vui lòng nhập mật khẩu tài khoản để xác nhận ký bằng chứng thư của hệ thống');
      }
      // 400 thay vì 401 — 401 sẽ làm FE tự refresh token và gửi lại request
      if (!(await this.staffService.verifyPassword(staffId, dto.staffPassword))) {
        throw new BadRequestException('Mật khẩu tài khoản không đúng');
      }
      credentials = this.signingCredentialsService.getServerCredentials();
      method = PartySignMethod.SYSTEM_SERVER_CERT;
    } else {
      if (!certFile?.length) throw new BadRequestException('Vui lòng chọn file chứng thư số (.p12 / .pfx)');
      credentials = loadPkcs12(certFile, dto.certPassword ?? '');
      method = PartySignMethod.SYSTEM_UPLOADED_CERT;
    }
    assertCertificateUsable(credentials.certificate);

    const unsigned = await this.documentStorageService.downloadPdf(addendum.unsignedPdfUrl!);
    let appearance = null;
    if (dto.visible !== false) {
      try {
        appearance = await this.signaturePlacementService.resolve(unsigned, 'B');
      } catch (err) {
        this.logger.warn(`Không xác định được vị trí chữ ký ${this.label(addendum)} HĐ ${contract.contractNo}: ${(err as Error).message}`);
      }
    }
    const signed = await this.padesSignService.sign(unsigned, {
      credentials,
      reason: `Ký ${this.label(addendum)} - Hợp đồng số ${contract.contractNo}`,
      location: contract.signPlace || undefined,
      appearance,
      fieldNamePrefix: 'BenB',
    });
    return this.acceptPartyBSignedPdf(contract, addendum, unsigned, signed, staffId, method);
  }

  private async acceptPartyBSignedPdf(
    contract: ContractDocument,
    addendum: AddendumDoc,
    unsignedBuffer: Buffer,
    fileBuffer: Buffer,
    staffId: string,
    method: PartySignMethod,
  ) {
    const signedInSystem = method !== PartySignMethod.EXTERNAL_UPLOAD;
    await this.tamperCheckService.assertIncrementalOnly(unsignedBuffer, fileBuffer);

    const signatures = this.padesVerifyService.verify(fileBuffer);
    const sig = signatures[signatures.length - 1];
    const valid = !!sig && sig.coversToEndOfFile && sig.digestValid && sig.signatureValid;
    if (!valid && signedInSystem) {
      this.logger.error(`Chữ ký số do hệ thống tạo không qua được xác thực (${this.label(addendum)} HĐ ${contract.contractNo})`);
      throw new InternalServerErrorException('Ký số thất bại — chữ ký tạo ra không hợp lệ, vui lòng thử lại');
    }
    if (signatures.length === 0) throw new BadRequestException('Không tìm thấy chữ ký số hợp lệ trong file tải lên');
    if (!valid) {
      addendum.partyBSignature = {
        ...(addendum.partyBSignature as object),
        status: PartySignatureStatus.REJECTED,
        rejectReason: 'Chữ ký số không hợp lệ (digest hoặc chữ ký không khớp)',
        uploadedAt: new Date(),
        uploadedBy: staffId,
      } as never;
      await contract.save();
      throw new BadRequestException(
        'Chữ ký số trong file không hợp lệ — vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung',
      );
    }

    const stored = await this.documentStorageService.uploadPdf(fileBuffer, `${this.storagePrefix(contract, addendum)}/party-b-signed`);
    const now = new Date();
    addendum.partyBSignature = {
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
      signMethod: method,
    } as never;
    await contract.save();

    await this.audit(
      staffId,
      signedInSystem ? 'CONTRACT_ADDENDUM_PARTY_B_SIGNED_IN_SYSTEM' : 'CONTRACT_ADDENDUM_PARTY_B_SIGNED',
      contract,
      addendum,
      { signerCertCN: sig.signerCertCN, signerCertSerial: sig.signerCertSerial, signMethod: method },
    );
    return this.contractsService.toAdminResponse(contract);
  }

  async rejectPartyASignature(contractId: string, addendumId: string, dto: RejectSignatureDto, staffId: string) {
    const contract = await this.loadContract(contractId);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.partyASignature?.status !== PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Phụ lục chưa có chữ ký Bên A hợp lệ để từ chối');
    }
    addendum.partyASignature.status = PartySignatureStatus.REJECTED;
    addendum.partyASignature.rejectReason = dto.reason;
    await contract.save();
    await this.audit(staffId, 'CONTRACT_ADDENDUM_PARTY_A_SIGNATURE_REJECT', contract, addendum, { reason: dto.reason });
    return this.contractsService.toAdminResponse(contract);
  }

  // ─── Public (khách qua link bảo mật của hợp đồng) ───────────────────────────

  /** Khách chỉ thấy phụ lục đã chốt / đã hủy — bản nháp còn đang soạn */
  private async resolvePublic(token: string, jwt: string | undefined, addendumId: string) {
    const contract = await this.contractsService.resolvePublicAccess(token, jwt);
    const addendum = this.findAddendum(contract, addendumId);
    if (addendum.status === AddendumStatus.DRAFT) throw new NotFoundException('Phụ lục không tồn tại');
    return { contract, addendum };
  }

  /** PDF phụ lục để khách xem — bản mới nhất: đã ký Bên A (PKI) > đã ký Bên B > bản gốc */
  async getPublicView(token: string, jwt: string | undefined, addendumId: string) {
    const { contract, addendum } = await this.resolvePublic(token, jwt, addendumId);
    const url = this.latestSignedUrl(addendum) || addendum.unsignedPdfUrl;
    if (!url) throw new NotFoundException('Phụ lục chưa có file PDF');
    const buffer = await this.documentStorageService.downloadPdf(url);
    return { buffer, filename: `${this.fileBase(contract, addendum)}.pdf` };
  }

  private assertPartyACanSign(contract: ContractDocument, addendum: AddendumDoc): void {
    if (contract.status === ContractStatus.CLOSED || addendum.status !== AddendumStatus.FINAL) {
      throw new BadRequestException('Phụ lục đã bị hủy, không thể ký');
    }
    if (addendum.partyBSignature?.status !== PartySignatureStatus.VERIFIED || !addendum.partyBSignature.signedPdfUrl) {
      throw new BadRequestException('Phụ lục chưa được Bên B ký, chưa thể ký');
    }
    if (addendum.partyASignature?.status === PartySignatureStatus.VERIFIED) {
      throw new BadRequestException('Phụ lục đã có chữ ký hợp lệ của Bên A, không thể ghi đè');
    }
  }

  async getDocumentToSign(token: string, jwt: string | undefined, addendumId: string) {
    const { contract, addendum } = await this.resolvePublic(token, jwt, addendumId);
    if (addendum.partyBSignature?.status !== PartySignatureStatus.VERIFIED || !addendum.partyBSignature.signedPdfUrl) {
      throw new BadRequestException('Phụ lục chưa được Bên B ký, chưa thể ký');
    }
    const buffer = await this.documentStorageService.downloadPdf(addendum.partyBSignature.signedPdfUrl);
    return { buffer, filename: `${this.fileBase(contract, addendum)}-can-ky.pdf` };
  }

  async uploadPartyASigned(token: string, jwt: string | undefined, addendumId: string, fileBuffer: Buffer) {
    const { contract, addendum } = await this.resolvePublic(token, jwt, addendumId);
    this.assertPartyACanSign(contract, addendum);

    const partyBBuffer = await this.documentStorageService.downloadPdf(addendum.partyBSignature.signedPdfUrl!);
    await this.tamperCheckService.assertIncrementalOnly(partyBBuffer, fileBuffer);

    const signatures = this.padesVerifyService.verify(fileBuffer);
    if (signatures.length < 2) {
      throw new BadRequestException(
        'Không tìm thấy chữ ký số của bạn trong file tải lên — vui lòng ký chồng lên đúng file đã tải từ hệ thống (đã có sẵn chữ ký Bên B)',
      );
    }
    const sig = signatures[signatures.length - 1];
    if (!sig.coversToEndOfFile || !sig.digestValid || !sig.signatureValid) {
      addendum.partyASignature = {
        ...(addendum.partyASignature as object),
        status: PartySignatureStatus.REJECTED,
        mode: SignatureMode.PKI,
        rejectReason: 'Chữ ký số không hợp lệ (digest hoặc chữ ký không khớp)',
        uploadedAt: new Date(),
      } as never;
      await contract.save();
      throw new BadRequestException(
        'Chữ ký số trong file không hợp lệ — vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung',
      );
    }

    const stored = await this.documentStorageService.uploadPdf(fileBuffer, `${this.storagePrefix(contract, addendum)}/party-a-signed`);
    const now = new Date();
    addendum.partyASignature = {
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
    } as never;
    await contract.save();

    await this.auditService.log({
      actorId: contract.userId?.toString() ?? 'unknown',
      actorType: 'user',
      action: 'CONTRACT_ADDENDUM_PARTY_A_SIGNED_PKI',
      module: 'contracts',
      targetId: contract._id.toString(),
      afterData: { addendumNo: addendum.addendumNo, signerCertCN: sig.signerCertCN, signerCertIssuer: sig.signerCertIssuer },
    });
    return this.contractsService.toPublicView(contract);
  }

  /** Chữ ký điện tử đơn giản (canvas) — không đụng file PDF đã ký Bên B */
  async submitPartyASimpleSignature(
    token: string,
    jwt: string | undefined,
    addendumId: string,
    dto: SubmitSimpleSignatureDto,
    ip: string,
    userAgent: string,
  ) {
    const { contract, addendum } = await this.resolvePublic(token, jwt, addendumId);
    this.assertPartyACanSign(contract, addendum);

    const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(dto.canvasImageBase64.trim());
    if (!match) throw new BadRequestException('Ảnh chữ ký không hợp lệ (cần định dạng PNG)');
    const imageBuffer = Buffer.from(match[1], 'base64');
    if (imageBuffer.length === 0 || imageBuffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException('Ảnh chữ ký không hợp lệ hoặc quá lớn');
    }

    const canvasImageUrl = await this.documentStorageService.uploadSignatureImage(
      imageBuffer,
      `${this.storagePrefix(contract, addendum)}/party-a-simple-signature`,
    );
    const now = new Date();
    const integrityHash = crypto
      .createHash('sha256')
      .update(`${canvasImageUrl}|${dto.confirmedName}|${contract._id.toString()}|${addendum._id.toString()}|${now.toISOString()}`)
      .digest('hex');

    addendum.partyASignature = {
      status: PartySignatureStatus.VERIFIED,
      mode: SignatureMode.SIMPLE,
      simpleSignature: { canvasImageUrl, confirmedName: dto.confirmedName, ipAddress: ip, userAgent, confirmedAt: now, integrityHash },
      chainValidated: false,
      uploadedAt: now,
      verifiedAt: now,
      rejectReason: '',
    } as never;
    await contract.save();

    await this.auditService.log({
      actorId: contract.userId?.toString() ?? 'unknown',
      actorType: 'user',
      action: 'CONTRACT_ADDENDUM_PARTY_A_SIGNED_SIMPLE',
      module: 'contracts',
      targetId: contract._id.toString(),
      afterData: { addendumNo: addendum.addendumNo, confirmedName: dto.confirmedName, ip },
    });
    return {
      ...this.contractsService.toPublicView(contract),
      legalNote:
        'Đây là chữ ký điện tử đơn giản để xác nhận nội dung phụ lục, KHÔNG phải chữ ký số (chữ ký điện tử an toàn) theo Nghị định 130/2018.',
    };
  }
}
