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
import * as crypto from 'crypto';
import {
  EInvoice,
  EInvoiceDocument,
  EInvoiceItem,
  EInvoiceKind,
  EInvoiceLocalStatus,
  EasyInvoiceStatus,
} from './schemas/einvoice.schema';
import { Contract, ContractDocument } from '../contracts/schemas/contract.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';
import {
  EasyInvoiceBuildInput,
  EasyInvoiceClientService,
  EasyInvoiceDownloadOption,
  EasyInvoiceInvoiceObject,
} from './easyinvoice-client.service';
import { numberToVietnameseWords } from './number-to-words.util';
import {
  CancelEInvoiceDto,
  CreateEInvoiceDto,
  PublishEInvoiceDraftDto,
  UpdateEInvoiceDraftDto,
  VerifyEInvoiceDto,
} from './dto/einvoice.dto';

/** Không dùng ký tự dễ nhầm lẫn (0/O, 1/I) — cùng bộ ký tự với Contract để đồng nhất trải nghiệm */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECURITY_CODE_LENGTH = 8;
const MAX_UNLOCK_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export type DownloadFormat = 'pdf' | 'xml' | 'pdf-origin' | 'pdf-archive';

const FORMAT_TO_OPTION: Record<DownloadFormat, EasyInvoiceDownloadOption> = {
  pdf: EasyInvoiceDownloadOption.PDF,
  xml: EasyInvoiceDownloadOption.XML,
  'pdf-origin': EasyInvoiceDownloadOption.PDF_ORIGIN_PROOF,
  'pdf-archive': EasyInvoiceDownloadOption.PDF_ARCHIVE,
};

@Injectable()
export class EInvoiceService {
  constructor(
    @InjectModel(EInvoice.name) private readonly model: Model<EInvoiceDocument>,
    @InjectModel(Contract.name) private readonly contractModel: Model<ContractDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly easyInvoiceClient: EasyInvoiceClientService,
    private readonly staffService: StaffService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private genSecurityCode(): string {
    let code = '';
    for (let i = 0; i < SECURITY_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    return code;
  }

  private genIkey(): string {
    return `INV${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  }

  /** Số hoá đơn bán hàng nội bộ — 6 chữ số ngẫu nhiên, không tuần tự (giống cách sinh contractNo) */
  private async genSalesInvoiceNo(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const no = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const exists = await this.model.exists({ invoiceNo: no, invoiceKind: EInvoiceKind.SALES });
      if (!exists) return no;
    }
    throw new BadRequestException('Không thể sinh số hoá đơn, vui lòng thử lại');
  }

  private publicUrl(accessToken: string): string {
    const base = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    return `${base.replace(/\/$/, '')}/invoice/${accessToken}`;
  }

  /**
   * EasyInvoice trả về ArisingDate/IssueDate dạng chuỗi "dd/MM/yyyy" (xem tài liệu tích hợp
   * mục "ArisingDate và IssueDate kiểu chuỗi theo format dd/MM/yyyy"). `new Date()` hiểu chuỗi
   * có dấu "/" theo kiểu MM/dd/yyyy nên phải parse thủ công, nếu không ngày > 12 sẽ ra Invalid Date.
   */
  private parseVNDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value.trim());
    if (!match) {
      const fallback = new Date(value);
      return Number.isNaN(fallback.getTime()) ? undefined : fallback;
    }
    const [, day, month, year] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  private computeItems(items: CreateEInvoiceDto['items']) {
    const computed = items.map((it, idx) => {
      const gross = it.quantity * it.unitPrice;
      const discountAmount = it.discountAmount ?? 0;
      const total = Math.round(gross - discountAmount);
      const rate = it.vatRate;
      const vatPercent = rate === -3 ? (it.vatRateOther ?? 0) : rate > 0 ? rate : 0;
      const vatAmount = rate >= 0 || rate === -3 ? Math.round((total * vatPercent) / 100) : 0;
      const amount = total + vatAmount;
      return {
        no: idx + 1,
        code: it.code,
        name: it.name,
        unit: it.unit || 'Cái',
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        discountPercent: it.discountPercent,
        discountAmount,
        vatRate: rate,
        vatRateOther: it.vatRateOther,
        feature: it.feature ?? 1,
        total,
        vatAmount,
        amount,
      };
    });

    const totalBeforeTax = computed.reduce((s, i) => s + i.total, 0);
    const vatAmount = computed.reduce((s, i) => s + i.vatAmount, 0);
    const totalAmount = computed.reduce((s, i) => s + i.amount, 0);
    return { computed, totalBeforeTax, vatAmount, totalAmount };
  }

  /** Loại bỏ dữ liệu nội bộ (khoá bảo mật, ikey, id liên kết…) trước khi trả về phía user */
  private sanitizeForUser(doc: EInvoiceDocument) {
    const e = doc.toObject();
    return {
      invoiceNo: e.invoiceNo,
      pattern: e.pattern,
      serial: e.serial,
      lookupCode: e.lookupCode,
      issueDate: e.issueDate,
      arisingDate: e.arisingDate,
      sellerName: this.easyInvoiceClient.sellerName,
      sellerTaxCode: this.easyInvoiceClient.sellerTaxCode,
      buyerName: e.buyerName,
      customerName: e.customerName,
      customerTaxCode: e.customerTaxCode,
      customerAddress: e.customerAddress,
      items: e.items,
      totalBeforeTax: e.totalBeforeTax,
      vatAmount: e.vatAmount,
      totalAmount: e.totalAmount,
      paymentMethod: e.paymentMethod,
      currencyUnit: e.currencyUnit,
      localStatus: e.localStatus,
      easyInvoiceStatus: e.easyInvoiceStatus,
      linkView: e.linkView,
      cancelledAt: e.cancelledAt,
      cancelReason: e.cancelReason,
      note: e.note,
    };
  }

  private toAdminResponse(doc: EInvoiceDocument) {
    const e = doc.toObject();
    delete (e as any).securityCode;
    return {
      ...e,
      publicUrl: this.publicUrl(e.accessToken),
      sellerName: this.easyInvoiceClient.sellerName,
      sellerTaxCode: this.easyInvoiceClient.sellerTaxCode,
      sellerAddress: this.easyInvoiceClient.sellerAddress,
    };
  }

  /** Kiểm tra đơn hàng/hợp đồng liên kết — trả về hợp đồng (kèm securityCode) nếu có */
  private async resolveLinks(dto: { orderId?: string; contractId?: string }) {
    let contract: ContractDocument | null = null;
    if (dto.contractId) {
      if (!Types.ObjectId.isValid(dto.contractId)) {
        throw new BadRequestException('Hợp đồng liên kết không hợp lệ');
      }
      contract = await this.contractModel
        .findById(dto.contractId)
        .select('+securityCode')
        .exec();
      if (!contract) throw new NotFoundException('Không tìm thấy hợp đồng liên kết');
    }

    if (dto.orderId && !Types.ObjectId.isValid(dto.orderId)) {
      throw new BadRequestException('Đơn hàng liên kết không hợp lệ');
    }
    if (dto.orderId) {
      const order = await this.orderModel.findById(dto.orderId).exec();
      if (!order) throw new NotFoundException('Không tìm thấy đơn hàng liên kết');
    }
    return contract;
  }

  /** Dữ liệu hoá đơn gửi sang EasyInvoice — dùng chung cho tạo mới, bản nháp và cập nhật ngày lập */
  private toEasyInvoiceInput(src: {
    ikey: string;
    buyerName: string;
    customerName: string;
    customerTaxCode?: string;
    customerAddress?: string;
    customerPhone?: string;
    customerEmail?: string;
    paymentMethod: string;
    currencyUnit?: string;
    arisingDate: Date;
    items: EInvoiceItem[];
    totalBeforeTax: number;
    vatAmount: number;
    totalAmount: number;
  }): EasyInvoiceBuildInput {
    return {
      ikey: src.ikey,
      buyer: src.buyerName,
      cusName: src.customerName,
      cusTaxCode: src.customerTaxCode || undefined,
      cusAddress: src.customerAddress || undefined,
      cusPhone: src.customerPhone || undefined,
      cusEmail: src.customerEmail || undefined,
      paymentMethod: src.paymentMethod,
      arisingDate: src.arisingDate,
      currencyUnit: src.currencyUnit || 'VND',
      products: src.items.map((c, idx) => ({
        code: c.code,
        no: idx + 1,
        feature: c.feature,
        name: c.name,
        unit: c.unit,
        quantity: c.quantity,
        price: c.unitPrice,
        discountPercent: c.discountPercent,
        discountAmount: c.discountAmount,
        total: c.total,
        vatRate: c.vatRate,
        vatRateOther: c.vatRateOther,
        vatAmount: c.vatAmount,
        amount: c.amount,
      })),
      total: src.totalBeforeTax,
      vatAmount: src.vatAmount,
      amount: src.totalAmount,
      amountInWords: numberToVietnameseWords(src.totalAmount),
    };
  }

  /** Ghi nhận kết quả phát hành từ EasyInvoice (số hoá đơn, mã tra cứu, trạng thái…) vào hoá đơn */
  private applyIssued(invoice: EInvoiceDocument, issued: EasyInvoiceInvoiceObject | undefined, invoiceNo?: string) {
    invoice.invoiceNo = issued?.No || invoiceNo || invoice.invoiceNo;
    if (issued?.Pattern) invoice.pattern = issued.Pattern;
    if (issued?.Serial) invoice.serial = issued.Serial;
    if (issued?.LookupCode) invoice.lookupCode = issued.LookupCode;
    if (issued?.LinkView) invoice.linkView = issued.LinkView;
    if (issued?.InvoiceStatus !== undefined) invoice.easyInvoiceStatus = issued.InvoiceStatus;
    if (issued?.TCTCheckStatus !== undefined) invoice.tctCheckStatus = issued.TCTCheckStatus;
    if (issued?.TCTErrorMessage !== undefined) invoice.tctErrorMessage = issued.TCTErrorMessage;
    invoice.issueDate = this.parseVNDate(issued?.IssueDate) ?? new Date();
    invoice.localStatus = EInvoiceLocalStatus.ISSUED;
    invoice.errorMessage = '';
  }

  /** Hoá đơn trên EasyInvoice đã được ký số (phát hành) — dùng để đối soát bản nháp */
  private isIssuedOnEasyInvoice(found: EasyInvoiceInvoiceObject | undefined): boolean {
    return (
      !!found?.No &&
      (found.InvoiceStatus === EasyInvoiceStatus.SIGNED ||
        found.InvoiceStatus === EasyInvoiceStatus.TAX_DECLARED)
    );
  }

  private async findDraftOrThrow(id: string): Promise<EInvoiceDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Hoá đơn không tồn tại');
    const invoice = await this.model.findById(id).exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');
    if (invoice.localStatus !== EInvoiceLocalStatus.DRAFT) {
      throw new BadRequestException('Chỉ thao tác được với hoá đơn đang ở trạng thái bản nháp');
    }
    if (invoice.publishLockUntil && invoice.publishLockUntil > new Date()) {
      throw new ConflictException('Bản nháp đang được phát hành, vui lòng thử lại sau ít phút');
    }
    return invoice;
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async create(dto: CreateEInvoiceDto, staffId: string) {
    const kind = dto.invoiceKind ?? EInvoiceKind.TAX_AUTHORITY;
    const isDraft = !!dto.saveAsDraft;
    if (isDraft && kind !== EInvoiceKind.TAX_AUTHORITY) {
      throw new BadRequestException('Chỉ hoá đơn Cơ quan Thuế mới hỗ trợ lưu bản nháp');
    }

    const contract = await this.resolveLinks(dto);

    const { computed, totalBeforeTax, vatAmount, totalAmount } = this.computeItems(dto.items);
    const arisingDate = dto.arisingDate ? new Date(dto.arisingDate) : new Date();
    const ikey = this.genIkey();
    const pattern = this.easyInvoiceClient.defaultPattern;
    const serial = this.easyInvoiceClient.defaultSerial;

    let issued: EasyInvoiceInvoiceObject | undefined;
    let invoiceNo: string | undefined;
    let issueDate: Date | undefined;

    if (kind === EInvoiceKind.SALES) {
      // Hoá đơn bán hàng nội bộ — KHÔNG gọi EasyInvoice, tự sinh số hoá đơn 6 chữ số.
      invoiceNo = await this.genSalesInvoiceNo();
      issueDate = arisingDate;
    } else {
      const input = this.toEasyInvoiceInput({
        ...dto,
        ikey,
        arisingDate,
        items: computed,
        totalBeforeTax,
        vatAmount,
        totalAmount,
      });

      if (isDraft) {
        // Bản nháp (V.1): EasyInvoice lưu hoá đơn chưa ký, chưa cấp số.
        const result = await this.easyInvoiceClient.importInvoice(input, pattern, serial);
        issued = result.Invoices?.[0];
      } else {
        const result = await this.easyInvoiceClient.importAndIssueInvoice(input, pattern, serial);
        issued = result.Invoices?.[0];
        invoiceNo = issued?.No;
        issueDate = this.parseVNDate(issued?.IssueDate) ?? new Date();
      }
    }

    // Khoá mở hoá đơn: liên kết hợp đồng -> dùng CHUNG khoá bảo mật của hợp đồng.
    // Không liên kết -> sinh khoá riêng cho hoá đơn.
    const sharedKeyFromContract = !!contract;
    const securityCode = contract ? contract.securityCode : this.genSecurityCode();
    const accessToken = crypto.randomBytes(24).toString('hex');

    const invoice = await this.model.create({
      invoiceKind: kind,
      ikey,
      pattern: issued?.Pattern || pattern,
      serial: issued?.Serial || serial,
      invoiceNo,
      lookupCode: issued?.LookupCode,
      linkView: issued?.LinkView,
      easyInvoiceStatus: issued?.InvoiceStatus,
      localStatus: isDraft ? EInvoiceLocalStatus.DRAFT : EInvoiceLocalStatus.ISSUED,
      orderId: dto.orderId ? new Types.ObjectId(dto.orderId) : undefined,
      contractId: contract ? contract._id : undefined,
      buyerName: dto.buyerName,
      customerName: dto.customerName,
      customerTaxCode: dto.customerTaxCode ?? '',
      customerAddress: dto.customerAddress ?? '',
      customerPhone: dto.customerPhone ?? '',
      customerEmail: dto.customerEmail ?? '',
      items: computed,
      totalBeforeTax,
      vatAmount,
      totalAmount,
      paymentMethod: dto.paymentMethod,
      currencyUnit: dto.currencyUnit || 'VND',
      arisingDate,
      issueDate,
      note: dto.note ?? '',
      accessToken,
      securityCode,
      sharedKeyFromContract,
      createdBy: new Types.ObjectId(staffId),
    });

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: isDraft ? 'EINVOICE_DRAFT_CREATE' : 'EINVOICE_CREATE',
      module: 'einvoice',
      targetId: invoice._id.toString(),
      afterData: { ikey, invoiceKind: kind, invoiceNo: invoice.invoiceNo, totalAmount, contractId: dto.contractId, orderId: dto.orderId },
    });

    return this.toAdminResponse(invoice);
  }

  /** Sửa bản nháp — import lại cùng ikey, EasyInvoice ghi đè hoá đơn đang ở trạng thái mới tạo lập (V.1) */
  async updateDraft(id: string, dto: UpdateEInvoiceDraftDto, staffId: string) {
    const invoice = await this.findDraftOrThrow(id);
    const contract = await this.resolveLinks(dto);

    const { computed, totalBeforeTax, vatAmount, totalAmount } = this.computeItems(dto.items);
    const arisingDate = dto.arisingDate ? new Date(dto.arisingDate) : invoice.arisingDate;

    const result = await this.easyInvoiceClient.importInvoice(
      this.toEasyInvoiceInput({
        ...dto,
        ikey: invoice.ikey,
        arisingDate,
        items: computed,
        totalBeforeTax,
        vatAmount,
        totalAmount,
      }),
      invoice.pattern,
      invoice.serial,
    );
    const imported = result.Invoices?.[0];
    if (imported?.InvoiceStatus !== undefined) invoice.easyInvoiceStatus = imported.InvoiceStatus;

    const before = { totalAmount: invoice.totalAmount, contractId: invoice.contractId?.toString() };

    // Đổi hợp đồng liên kết -> đổi khoá mở hoá đơn theo (dùng chung khoá hợp đồng mới,
    // hoặc sinh khoá riêng nếu bỏ liên kết hợp đồng).
    const prevContractId = invoice.contractId?.toString();
    if (contract && contract._id.toString() !== prevContractId) {
      invoice.securityCode = contract.securityCode;
      invoice.sharedKeyFromContract = true;
    } else if (!contract && invoice.sharedKeyFromContract) {
      invoice.securityCode = this.genSecurityCode();
      invoice.sharedKeyFromContract = false;
    }

    invoice.orderId = dto.orderId ? new Types.ObjectId(dto.orderId) : undefined;
    invoice.contractId = contract ? contract._id : undefined;
    invoice.buyerName = dto.buyerName;
    invoice.customerName = dto.customerName;
    invoice.customerTaxCode = dto.customerTaxCode ?? '';
    invoice.customerAddress = dto.customerAddress ?? '';
    invoice.customerPhone = dto.customerPhone ?? '';
    invoice.customerEmail = dto.customerEmail ?? '';
    invoice.items = computed;
    invoice.totalBeforeTax = totalBeforeTax;
    invoice.vatAmount = vatAmount;
    invoice.totalAmount = totalAmount;
    invoice.paymentMethod = dto.paymentMethod;
    invoice.currencyUnit = dto.currencyUnit || 'VND';
    invoice.arisingDate = arisingDate;
    invoice.note = dto.note ?? '';
    await invoice.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_DRAFT_UPDATE',
      module: 'einvoice',
      targetId: id,
      beforeData: before,
      afterData: { totalAmount, contractId: dto.contractId },
    });

    return this.toAdminResponse(invoice);
  }

  /**
   * Chuyển bản nháp thành hoá đơn chính thức — phát hành ký server (V.10.1 api/publish/issueInvoices).
   * Nếu truyền ngày lập mới, cập nhật bản nháp trên EasyInvoice (import lại cùng ikey) trước khi phát hành.
   */
  async publishDraft(id: string, dto: PublishEInvoiceDraftDto, staffId: string) {
    await this.findDraftOrThrow(id);

    // Khoá nguyên tử: chỉ 1 request được phát hành, đồng thời chặn sửa/xoá trong lúc phát hành.
    const now = new Date();
    const invoice = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          localStatus: EInvoiceLocalStatus.DRAFT,
          $or: [{ publishLockUntil: { $exists: false } }, { publishLockUntil: { $lte: now } }],
        },
        { $set: { publishLockUntil: new Date(now.getTime() + 2 * 60 * 1000) } },
        { new: true },
      )
      .exec();
    if (!invoice) {
      throw new ConflictException('Bản nháp đang được phát hành hoặc đã được phát hành');
    }

    try {
      if (dto.arisingDate) {
        const newDate = new Date(dto.arisingDate);
        if (newDate.toDateString() !== invoice.arisingDate.toDateString()) {
          await this.easyInvoiceClient.importInvoice(
            this.toEasyInvoiceInput({ ...invoice.toObject(), ikey: invoice.ikey, arisingDate: newDate }),
            invoice.pattern,
            invoice.serial,
          );
          invoice.arisingDate = newDate;
        }
      }

      let issued: EasyInvoiceInvoiceObject | undefined;
      let issuedNo: string | undefined;
      try {
        const result = await this.easyInvoiceClient.issueInvoices(
          [invoice.ikey],
          invoice.pattern,
          invoice.serial,
        );
        issued = result.Invoices?.find((i) => i.Ikey === invoice.ikey) ?? result.Invoices?.[0];
        issuedNo = result.KeyInvoiceNo?.[invoice.ikey];
      } catch (err) {
        // Mất kết nối/timeout sau khi EasyInvoice đã ký -> đối soát lại để không kẹt ở bản nháp.
        const found = await this.easyInvoiceClient
          .getInvoicesByIkeys([invoice.ikey])
          .then((r) => r.Invoices?.[0])
          .catch(() => undefined);
        if (!this.isIssuedOnEasyInvoice(found)) {
          invoice.errorMessage = (err as Error).message;
          throw err;
        }
        issued = found;
      }

      this.applyIssued(invoice, issued, issuedNo);
      invoice.publishedBy = new Types.ObjectId(staffId);
      invoice.publishedAt = new Date();
    } finally {
      invoice.publishLockUntil = undefined;
      await invoice.save();
    }

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_PUBLISH',
      module: 'einvoice',
      targetId: id,
      beforeData: { localStatus: EInvoiceLocalStatus.DRAFT },
      afterData: { localStatus: EInvoiceLocalStatus.ISSUED, invoiceNo: invoice.invoiceNo },
    });

    return this.toAdminResponse(invoice);
  }

  /** Xoá bản nháp — xoá trên EasyInvoice (V.7 removeUnsignedInvoice) rồi xoá mềm tại hệ thống */
  async deleteDraft(id: string, staffId: string) {
    const invoice = await this.findDraftOrThrow(id);

    try {
      await this.easyInvoiceClient.removeUnsignedInvoice(invoice.ikey, invoice.pattern, invoice.serial);
    } catch (err) {
      // Bản nháp có thể đã bị xoá/phát hành trực tiếp trên cổng EasyInvoice — chỉ xoá local
      // khi xác nhận không còn tồn tại; nếu đã ký số thì phải đồng bộ thay vì xoá.
      const stillExists = await this.easyInvoiceClient
        .getInvoicesByIkeys([invoice.ikey])
        .then((r) => !!r.Invoices?.length)
        .catch(() => true);
      if (stillExists) throw err;
    }

    invoice.isDeleted = true;
    invoice.deletedAt = new Date();
    await invoice.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_DRAFT_DELETE',
      module: 'einvoice',
      targetId: id,
      beforeData: { ikey: invoice.ikey, totalAmount: invoice.totalAmount },
    });

    return { deleted: true };
  }

  async findAll(params: {
    page: number;
    limit: number;
    localStatus?: string;
    search?: string;
    orderId?: string;
    contractId?: string;
    invoiceKind?: string;
  }) {
    const { page, limit, localStatus, search, orderId, contractId, invoiceKind } = params;
    const filter: Record<string, unknown> = {};
    if (localStatus) filter.localStatus = localStatus;
    if (invoiceKind) filter.invoiceKind = invoiceKind;
    if (orderId && Types.ObjectId.isValid(orderId)) filter.orderId = new Types.ObjectId(orderId);
    if (contractId && Types.ObjectId.isValid(contractId)) filter.contractId = new Types.ObjectId(contractId);
    if (search) {
      filter.$or = [
        { invoiceNo: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
        { buyerName: { $regex: search, $options: 'i' } },
        { customerTaxCode: { $regex: search, $options: 'i' } },
      ];
    }

    const [docs, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .exec(),
      this.model.countDocuments(filter),
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
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Hoá đơn không tồn tại');
    const invoice = await this.model
      .findById(id)
      .populate('createdBy', 'name email')
      .exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');
    return this.toAdminResponse(invoice);
  }

  /** Xem khoá mở hoá đơn — yêu cầu xác nhận lại mật khẩu tài khoản admin (giống Contract.revealCode) */
  async revealKey(id: string, staffId: string, password: string) {
    const valid = await this.staffService.verifyPassword(staffId, password);
    if (!valid) throw new UnauthorizedException('Mật khẩu không đúng');

    const invoice = await this.model.findById(id).select('+securityCode').exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_REVEAL_KEY',
      module: 'einvoice',
      targetId: id,
    });

    return { securityCode: invoice.securityCode, sharedKeyFromContract: invoice.sharedKeyFromContract };
  }

  async cancel(id: string, dto: CancelEInvoiceDto, staffId: string) {
    const invoice = await this.model.findById(id).exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');
    if (invoice.localStatus === EInvoiceLocalStatus.CANCELLED) {
      throw new BadRequestException('Hoá đơn đã được huỷ trước đó');
    }
    if (invoice.localStatus === EInvoiceLocalStatus.DRAFT) {
      throw new BadRequestException('Bản nháp chưa phát hành — vui lòng dùng chức năng Xoá bản nháp');
    }

    // Hoá đơn bán hàng nội bộ không được phát hành qua EasyInvoice nên chỉ huỷ cục bộ.
    if (invoice.invoiceKind !== EInvoiceKind.SALES) {
      const result = await this.easyInvoiceClient.cancelInvoice(
        invoice.ikey,
        invoice.pattern,
        invoice.serial,
      );
      const cancelled = result.Invoices?.[0];
      if (cancelled?.InvoiceStatus !== undefined) invoice.easyInvoiceStatus = cancelled.InvoiceStatus;
    }

    invoice.localStatus = EInvoiceLocalStatus.CANCELLED;
    invoice.cancelReason = dto.reason ?? '';
    invoice.cancelledAt = new Date();
    await invoice.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_CANCEL',
      module: 'einvoice',
      targetId: id,
      beforeData: { localStatus: EInvoiceLocalStatus.ISSUED },
      afterData: { localStatus: EInvoiceLocalStatus.CANCELLED, reason: dto.reason },
    });

    return this.toAdminResponse(invoice);
  }

  /** Đồng bộ lại trạng thái mới nhất từ EasyInvoice (khai thuế, CQT duyệt…) */
  async syncStatus(id: string, staffId: string) {
    const invoice = await this.model.findById(id).exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');
    if (invoice.invoiceKind === EInvoiceKind.SALES) {
      throw new BadRequestException('Hoá đơn mua bán không đồng bộ với cơ quan thuế');
    }

    const result = await this.easyInvoiceClient.getInvoicesByIkeys([invoice.ikey]);
    const found = result.Invoices?.[0];
    if (found && invoice.localStatus === EInvoiceLocalStatus.DRAFT) {
      // Bản nháp có thể đã được ký trực tiếp trên cổng EasyInvoice -> chuyển sang chính thức.
      if (this.isIssuedOnEasyInvoice(found)) this.applyIssued(invoice, found);
      else if (found.InvoiceStatus !== undefined) invoice.easyInvoiceStatus = found.InvoiceStatus;
      await invoice.save();
    } else if (found) {
      if (found.InvoiceStatus !== undefined) invoice.easyInvoiceStatus = found.InvoiceStatus;
      if (found.TCTCheckStatus !== undefined) invoice.tctCheckStatus = found.TCTCheckStatus;
      if (found.TCTErrorMessage !== undefined) invoice.tctErrorMessage = found.TCTErrorMessage;
      if (found.No) invoice.invoiceNo = found.No;
      if (found.LookupCode) invoice.lookupCode = found.LookupCode;
      await invoice.save();
    }

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'EINVOICE_SYNC_STATUS',
      module: 'einvoice',
      targetId: id,
    });

    return this.toAdminResponse(invoice);
  }

  async downloadAdmin(id: string, format: DownloadFormat) {
    const invoice = await this.model.findById(id).exec();
    if (!invoice) throw new NotFoundException('Hoá đơn không tồn tại');
    return this.downloadFile(invoice, format);
  }

  private async downloadFile(invoice: EInvoiceDocument, format: DownloadFormat) {
    if (invoice.invoiceKind === EInvoiceKind.SALES) {
      throw new BadRequestException(
        'Hoá đơn mua bán không có bản PDF/XML từ cơ quan thuế — vui lòng dùng chức năng In hoá đơn',
      );
    }
    const option = FORMAT_TO_OPTION[format] ?? EasyInvoiceDownloadOption.PDF;
    const { buffer, contentType } = await this.easyInvoiceClient.getInvoicePdf(
      invoice.ikey,
      invoice.pattern,
      option,
    );
    const ext = format === 'xml' ? 'xml' : 'pdf';
    const prefix = invoice.localStatus === EInvoiceLocalStatus.DRAFT ? 'ban-nhap-hoa-don' : 'hoa-don';
    const filename = `${prefix}-${invoice.invoiceNo || invoice.ikey}.${ext}`;
    return { buffer, contentType, filename };
  }

  // ─── Public (khách truy cập qua link + khoá mở hoá đơn) ─────────────────────

  async getPublicMeta(token: string) {
    const invoice = await this.model.findOne({ accessToken: token }).exec();
    if (!invoice) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    this.assertPublicAccessible(invoice);
    return {
      sellerName: this.easyInvoiceClient.sellerName,
      localStatus: invoice.localStatus,
      hasInvoiceNo: !!invoice.invoiceNo,
      arisingDate: invoice.arisingDate,
    };
  }

  async verifyAccess(token: string, dto: VerifyEInvoiceDto) {
    const invoice = await this.model
      .findOne({ accessToken: token })
      .select('+securityCode')
      .exec();
    if (!invoice) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    this.assertPublicAccessible(invoice);

    if (invoice.lockedUntil && invoice.lockedUntil > new Date()) {
      const minutes = Math.ceil((invoice.lockedUntil.getTime() - Date.now()) / 60000);
      throw new ForbiddenException(
        `Nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút`,
      );
    }

    const codeOk = dto.securityCode.replace(/\s/g, '').toUpperCase() === invoice.securityCode;
    if (!codeOk) {
      invoice.unlockAttempts += 1;
      if (invoice.unlockAttempts >= MAX_UNLOCK_ATTEMPTS) {
        invoice.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        invoice.unlockAttempts = 0;
      }
      await invoice.save();
      throw new UnauthorizedException('Khoá mở hoá đơn không đúng');
    }

    if (invoice.unlockAttempts > 0 || invoice.lockedUntil) {
      invoice.unlockAttempts = 0;
      invoice.lockedUntil = undefined;
      await invoice.save();
    }

    const accessJwt = await this.jwtService.signAsync(
      { sub: invoice._id.toString(), typ: 'einvoice-access' },
      { secret: this.configService.get<string>('JWT_SECRET'), expiresIn: '4h' },
    );

    return { accessJwt, invoice: this.sanitizeForUser(invoice) };
  }

  private async resolveAuthorized(token: string, jwt?: string): Promise<EInvoiceDocument> {
    if (!jwt) throw new UnauthorizedException('Vui lòng nhập khoá để mở hoá đơn');

    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwtService.verifyAsync(jwt, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Phiên đã hết hạn, vui lòng xác thực lại');
    }
    if (payload.typ !== 'einvoice-access') throw new UnauthorizedException('Phiên không hợp lệ');

    const invoice = await this.model.findOne({ accessToken: token }).exec();
    if (!invoice) throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    if (payload.sub !== invoice._id.toString()) throw new UnauthorizedException('Phiên không hợp lệ');
    this.assertPublicAccessible(invoice);
    return invoice;
  }

  /**
   * Hoá đơn bán hàng nội bộ không có mục đích xác thực công khai, bản nháp chưa có giá trị pháp lý
   * — ẩn hoàn toàn khỏi route public.
   */
  private assertPublicAccessible(invoice: EInvoiceDocument): void {
    if (
      invoice.invoiceKind === EInvoiceKind.SALES ||
      invoice.localStatus === EInvoiceLocalStatus.DRAFT
    ) {
      throw new NotFoundException('Liên kết không hợp lệ hoặc đã bị xóa');
    }
  }

  async getPublicInvoice(token: string, jwt?: string) {
    const invoice = await this.resolveAuthorized(token, jwt);
    return this.sanitizeForUser(invoice);
  }

  async downloadPublic(token: string, jwt: string | undefined, format: DownloadFormat) {
    const invoice = await this.resolveAuthorized(token, jwt);
    return this.downloadFile(invoice, format);
  }
}
