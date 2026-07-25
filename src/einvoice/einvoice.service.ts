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
  EInvoice,
  EInvoiceDocument,
  EInvoiceKind,
  EInvoiceLocalStatus,
} from './schemas/einvoice.schema';
import { Contract, ContractDocument } from '../contracts/schemas/contract.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';
import {
  EasyInvoiceClientService,
  EasyInvoiceDownloadOption,
  EasyInvoiceInvoiceObject,
  EasyInvoiceProductInput,
} from './easyinvoice-client.service';
import { numberToVietnameseWords } from './number-to-words.util';
import { CancelEInvoiceDto, CreateEInvoiceDto, VerifyEInvoiceDto } from './dto/einvoice.dto';

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

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async create(dto: CreateEInvoiceDto, staffId: string) {
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

    const { computed, totalBeforeTax, vatAmount, totalAmount } = this.computeItems(dto.items);
    const arisingDate = dto.arisingDate ? new Date(dto.arisingDate) : new Date();
    const ikey = this.genIkey();
    const pattern = this.easyInvoiceClient.defaultPattern;
    const serial = this.easyInvoiceClient.defaultSerial;
    const kind = dto.invoiceKind ?? EInvoiceKind.TAX_AUTHORITY;

    let issued: EasyInvoiceInvoiceObject | undefined;
    let invoiceNo: string | undefined;
    let issueDate: Date;

    if (kind === EInvoiceKind.SALES) {
      // Hoá đơn bán hàng nội bộ — KHÔNG gọi EasyInvoice, tự sinh số hoá đơn 6 chữ số.
      invoiceNo = await this.genSalesInvoiceNo();
      issueDate = arisingDate;
    } else {
      const products: EasyInvoiceProductInput[] = computed.map((c) => ({
        code: c.code,
        no: c.no,
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
      }));

      const result = await this.easyInvoiceClient.importAndIssueInvoice(
        {
          ikey,
          buyer: dto.buyerName,
          cusName: dto.customerName,
          cusTaxCode: dto.customerTaxCode,
          cusAddress: dto.customerAddress,
          cusPhone: dto.customerPhone,
          cusEmail: dto.customerEmail,
          paymentMethod: dto.paymentMethod,
          arisingDate,
          currencyUnit: dto.currencyUnit || 'VND',
          products,
          total: totalBeforeTax,
          vatAmount,
          amount: totalAmount,
          amountInWords: numberToVietnameseWords(totalAmount),
        },
        pattern,
        serial,
      );

      issued = result.Invoices?.[0];
      invoiceNo = issued?.No;
      issueDate = this.parseVNDate(issued?.IssueDate) ?? new Date();
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
      localStatus: EInvoiceLocalStatus.ISSUED,
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
      action: 'EINVOICE_CREATE',
      module: 'einvoice',
      targetId: invoice._id.toString(),
      afterData: { ikey, invoiceKind: kind, invoiceNo: invoice.invoiceNo, totalAmount, contractId: dto.contractId, orderId: dto.orderId },
    });

    return this.toAdminResponse(invoice);
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
    if (found) {
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
    const filename = `hoa-don-${invoice.invoiceNo || invoice.ikey}.${ext}`;
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

  /** Hoá đơn bán hàng nội bộ không có mục đích xác thực công khai — ẩn hoàn toàn khỏi route public */
  private assertPublicAccessible(invoice: EInvoiceDocument): void {
    if (invoice.invoiceKind === EInvoiceKind.SALES) {
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
