import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';

/** Lỗi trả về từ EasyInvoice (Status khác 2) — message + errorCode + chi tiết theo từng ikey */
export class EasyInvoiceApiError extends HttpException {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly keyInvoiceMsg?: Record<string, string>,
  ) {
    super(
      {
        message: `EasyInvoice: ${message}`,
        errorCode,
        keyInvoiceMsg,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}

interface EasyInvoiceEnvelope<T> {
  Status: number | string;
  Message: string;
  ErrorCode?: string;
  Data?: T & { KeyInvoiceMsg?: Record<string, string> };
}

export interface EasyInvoiceInvoiceObject {
  InvoiceStatus?: number;
  Buyer?: string;
  No?: string;
  Pattern?: string;
  Serial?: string;
  LookupCode?: string;
  Ikey?: string;
  ArisingDate?: string;
  IssueDate?: string;
  CustomerName?: string;
  CustomerCode?: string;
  CustomerTaxCode?: string;
  Total?: number;
  Amount?: number;
  LinkView?: string;
  TCTCheckStatus?: string;
  TCTErrorMessage?: string;
}

export interface ImportAndIssueResult {
  Pattern?: string;
  Serial?: string;
  KeyInvoiceNo?: Record<string, string>;
  Invoices?: EasyInvoiceInvoiceObject[];
}

export interface CancelInvoiceResult {
  Pattern?: string;
  Serial?: string;
  KeyInvoiceNo?: Record<string, string>;
  Invoices?: EasyInvoiceInvoiceObject[];
}

export interface GetInvoicesByIkeysResult {
  Invoices?: EasyInvoiceInvoiceObject[];
}

export interface EasyInvoiceProductInput {
  code?: string;
  no: number;
  feature: number;
  name: string;
  unit: string;
  quantity: number;
  price: number;
  discountPercent?: number;
  discountAmount?: number;
  total: number;
  vatRate: number;
  vatRateOther?: number;
  vatAmount: number;
  amount: number;
}

export interface EasyInvoiceBuildInput {
  ikey: string;
  buyer: string;
  cusName: string;
  cusTaxCode?: string;
  cusAddress?: string;
  cusPhone?: string;
  cusEmail?: string;
  paymentMethod: string;
  arisingDate: Date;
  currencyUnit: string;
  products: EasyInvoiceProductInput[];
  total: number;
  vatAmount: number;
  amount: number;
  amountInWords: string;
}

/** Download option cho api/publish/getInvoicePdf — xem mục IV.24 tài liệu tích hợp */
export enum EasyInvoiceDownloadOption {
  XML = -1,
  PDF = 0,
  PDF_ORIGIN_PROOF = 1,
  PDF_ARCHIVE = 2,
}

/**
 * Client tích hợp EasyInvoice (Hoá đơn điện tử) — tài liệu: EasyInvoice_TaiLieuTichHop_v8.0
 *
 * Xác thực (mục IV — áp dụng cơ chế MỚI từ 01/01/2026, có bổ sung taxCode):
 *   Header "Authentication": signature:nonce:timestamp:username:password:taxCode
 *   signature = base64(MD5(HttpMethod + timestamp + nonce))
 */
@Injectable()
export class EasyInvoiceClientService {
  private readonly logger = new Logger(EasyInvoiceClientService.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config
      .get<string>('EASYINVOICE_API_URL', 'http://api.softdreams.vn')
      .replace(/\/+$/, '');
  }

  private get credentials() {
    return {
      username: this.config.get<string>('EASYINVOICE_USERNAME', ''),
      password: this.config.get<string>('EASYINVOICE_PASSWORD', ''),
      taxCode: this.config.get<string>('EASYINVOICE_TAX_CODE', ''),
    };
  }

  get defaultPattern(): string {
    return this.config.get<string>('EASYINVOICE_PATTERN', '');
  }

  get defaultSerial(): string {
    return this.config.get<string>('EASYINVOICE_SERIAL', '');
  }

  get sellerName(): string {
    return this.config.get<string>('EASYINVOICE_SELLER_NAME', 'Luxe Glow');
  }

  get sellerTaxCode(): string {
    return this.config.get<string>('EASYINVOICE_SELLER_TAX_CODE', '');
  }

  get sellerAddress(): string {
    return this.config.get<string>(
      'EASYINVOICE_SELLER_ADDRESS',
      '315/3 Vườn Lài, Phường Phú Thọ Hòa, Thành phố Hồ Chí Minh, Việt Nam',
    );
  }

  // ─── Xác thực ────────────────────────────────────────────────────────────

  private buildAuthHeader(httpMethod: string): string {
    const { username, password, taxCode } = this.credentials;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signatureRaw = `${httpMethod.toUpperCase()}${timestamp}${nonce}`;
    const signature = createHash('md5').update(signatureRaw, 'utf8').digest('base64');
    return `${signature}:${nonce}:${timestamp}:${username}:${password}:${taxCode}`;
  }

  // ─── HTTP core ───────────────────────────────────────────────────────────

  private async postJson<T>(resource: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}/${resource}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authentication: this.buildAuthHeader('POST'),
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.logger.error(`Không thể kết nối EasyInvoice (${resource}): ${(err as Error).message}`);
      throw new ServiceUnavailableException('Không thể kết nối tới dịch vụ EasyInvoice');
    }

    let json: EasyInvoiceEnvelope<T> | null = null;
    try {
      json = (await res.json()) as EasyInvoiceEnvelope<T>;
    } catch {
      throw new BadGatewayException(`EasyInvoice trả về phản hồi không hợp lệ (HTTP ${res.status})`);
    }

    if (!json || Number(json.Status) !== 2) {
      throw new EasyInvoiceApiError(
        json?.Message || `EasyInvoice trả về lỗi HTTP ${res.status}`,
        json?.ErrorCode,
        json?.Data?.KeyInvoiceMsg,
      );
    }
    return json.Data as T;
  }

  /** api/publish/importAndIssueInvoice — Tạo và phát hành hoá đơn (ký server) */
  async importAndIssueInvoice(input: EasyInvoiceBuildInput, pattern?: string, serial?: string) {
    const xmlData = this.buildInvoiceXml(input);
    return this.postJson<ImportAndIssueResult>('api/publish/importAndIssueInvoice', {
      XmlData: xmlData,
      Pattern: pattern || undefined,
      Serial: serial || undefined,
    });
  }

  /** api/business/cancelInvoice — Huỷ bỏ hoá đơn đã phát hành (đã ký số) */
  async cancelInvoice(ikey: string, pattern?: string, serial?: string) {
    return this.postJson<CancelInvoiceResult>('api/business/cancelInvoice', {
      Ikey: ikey,
      Pattern: pattern || undefined,
      Serial: serial || undefined,
    });
  }

  /** api/publish/getInvoicesByIkeys — Truy vấn thông tin hoá đơn theo tập khoá Ikeys */
  async getInvoicesByIkeys(ikeys: string[]) {
    return this.postJson<GetInvoicesByIkeysResult>('api/publish/getInvoicesByIkeys', {
      Ikeys: ikeys,
    });
  }

  /** api/publish/getInvoicePdf — Tải hoá đơn định dạng PDF/XML */
  async getInvoicePdf(
    ikey: string,
    pattern: string | undefined,
    option: EasyInvoiceDownloadOption,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const url = `${this.baseUrl}/api/publish/getInvoicePdf`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authentication: this.buildAuthHeader('POST'),
        },
        body: JSON.stringify({ Ikey: ikey, Pattern: pattern || undefined, Option: option }),
      });
    } catch (err) {
      this.logger.error(`Không thể kết nối EasyInvoice (getInvoicePdf): ${(err as Error).message}`);
      throw new ServiceUnavailableException('Không thể kết nối tới dịch vụ EasyInvoice');
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = (await res.json().catch(() => null)) as EasyInvoiceEnvelope<unknown> | null;
      throw new EasyInvoiceApiError(
        json?.Message || 'Tải hoá đơn thất bại',
        json?.ErrorCode,
        json?.Data?.KeyInvoiceMsg,
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(`EasyInvoice trả về lỗi HTTP ${res.status} khi tải hoá đơn`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: contentType || (option === EasyInvoiceDownloadOption.XML ? 'application/xml' : 'application/pdf'),
    };
  }

  // ─── XML builder ─────────────────────────────────────────────────────────

  private escapeXml(value: string | number | undefined | null): string {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private formatDateVN(date: Date): string {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
  }

  private tag(name: string, value: string | number | undefined | null): string {
    if (value === undefined || value === null || value === '') return '';
    return `<${name}>${this.escapeXml(value)}</${name}>`;
  }

  /** Tổng theo mức thuế suất cụ thể — dùng cho các thẻ GrossValueX/VatAmountX/AmountX (VII.3) */
  private sumByRate(products: EasyInvoiceProductInput[], rate: number) {
    const matched = products.filter((p) => p.vatRate === rate);
    return {
      gross: matched.reduce((s, p) => s + p.total, 0),
      vat: matched.reduce((s, p) => s + p.vatAmount, 0),
      amount: matched.reduce((s, p) => s + p.amount, 0),
    };
  }

  /**
   * Xây dựng XmlData cho api/publish/importAndIssueInvoice.
   * Chỉ hỗ trợ các trường phổ biến cho hoá đơn bán lẻ/dịch vụ thông thường
   * (không hỗ trợ hoá đơn kèm bảng kê, tài sản công, hàng dự trữ quốc gia, CTTC…).
   */
  buildInvoiceXml(input: EasyInvoiceBuildInput): string {
    const products = input.products
      .map((p) => {
        const rateTag =
          p.vatRate === -3
            ? this.tag('VATRate', p.vatRate) + this.tag('VATRateOther', p.vatRateOther)
            : this.tag('VATRate', p.vatRate);
        return `<Product>
${this.tag('Code', p.code)}
${this.tag('No', p.no)}
${this.tag('Feature', p.feature)}
${this.tag('ProdName', p.name)}
${this.tag('ProdUnit', p.unit)}
${this.tag('ProdQuantity', p.quantity)}
${this.tag('ProdPrice', p.price)}
${this.tag('Discount', p.discountPercent)}
${this.tag('DiscountAmount', p.discountAmount)}
${this.tag('Total', p.total)}
${rateTag}
${this.tag('VATAmount', p.vatAmount)}
${this.tag('Amount', p.amount)}
</Product>`;
      })
      .join('\n');

    const uniformRate = input.products.every((p) => p.vatRate === input.products[0]?.vatRate)
      ? input.products[0]?.vatRate
      : undefined;

    const rate0 = this.sumByRate(input.products, 0);
    const rate5 = this.sumByRate(input.products, 5);
    const rate8 = this.sumByRate(input.products, 8);
    const rate10 = this.sumByRate(input.products, 10);
    const rateKct = this.sumByRate(input.products, -1);

    return `<Invoices>
<Inv>
<Invoice>
${this.tag('Ikey', input.ikey)}
${this.tag('Buyer', input.buyer)}
${this.tag('CusName', input.cusName)}
${this.tag('Email', input.cusEmail)}
${this.tag('CusAddress', input.cusAddress)}
${this.tag('CusPhone', input.cusPhone)}
${this.tag('CusTaxCode', input.cusTaxCode)}
${this.tag('PaymentMethod', input.paymentMethod)}
${this.tag('ArisingDate', this.formatDateVN(input.arisingDate))}
${this.tag('CurrencyUnit', input.currencyUnit)}
<Products>
${products}
</Products>
${this.tag('Total', input.total)}
${uniformRate !== undefined ? this.tag('VATRate', uniformRate) : ''}
${this.tag('VATAmount', input.vatAmount)}
${this.tag('Amount', input.amount)}
${rateKct.gross ? this.tag('GrossValue', rateKct.gross) : ''}
${rate0.gross ? this.tag('GrossValue0', rate0.gross) + this.tag('VatAmount0', rate0.vat) + this.tag('Amount0', rate0.amount) : ''}
${rate5.gross ? this.tag('GrossValue5', rate5.gross) + this.tag('VatAmount5', rate5.vat) + this.tag('Amount5', rate5.amount) : ''}
${rate8.gross ? this.tag('GrossValue8', rate8.gross) + this.tag('VatAmount8', rate8.vat) + this.tag('Amount8', rate8.amount) : ''}
${rate10.gross ? this.tag('GrossValue10', rate10.gross) + this.tag('VatAmount10', rate10.vat) + this.tag('Amount10', rate10.amount) : ''}
${this.tag('AmountInWords', input.amountInWords)}
</Invoice>
</Inv>
</Invoices>`;
  }
}
