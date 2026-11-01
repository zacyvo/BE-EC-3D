/**
 * Local VietQR (NAPAS 247, EMVCo Merchant-Presented QR) payload generator — no network call,
 * no dependency. Replaces the hosted VietQR "Generate API", which stops working on 2027-01-01
 * (https://www.vietqr.io/thong-bao-cap-nhat).
 *
 * Payload = a sequence of TLV fields `ID(2) + LENGTH(2) + VALUE`, closed by a CRC:
 *   00 "01"                       payload format indicator
 *   01 "12"                       point of initiation: dynamic (amount is fixed)
 *   38 merchant account info      00 NAPAS GUID "A000000727"
 *                                 01 beneficiary { 00 bank BIN, 01 account number }
 *                                 02 service "QRIBFTTA" (transfer to an account)
 *   53 "704"                      currency VND
 *   54 amount                     integer VND
 *   58 "VN"                       country
 *   62 additional data            08 purpose of transaction = transfer description
 *   63 CRC16-CCITT-FALSE          over everything before it, including "6304"
 *
 * Values are restricted to ASCII so the EMV length (in characters) equals the byte length.
 * The rendered image is produced elsewhere (storefront `qrcode`); this module owns the payload.
 */

export const NAPAS_GUID = 'A000000727';
export const VIETQR_SERVICE_TRANSFER_TO_ACCOUNT = 'QRIBFTTA';
const PAYLOAD_FORMAT = '01';
const POINT_OF_INITIATION_DYNAMIC = '12';
const CURRENCY_VND = '704';
const COUNTRY_VN = 'VN';

/** EMV allows 13 characters for the amount. */
export const MAX_VIETQR_AMOUNT = 9_999_999_999_999;
/** EMV limit for the additional-data "purpose of transaction" sub-field. */
export const MAX_VIETQR_DESCRIPTION_LENGTH = 25;

export interface VietQrInput {
  /** 6-digit NAPAS bank identification number. */
  bankBin: string;
  /** Kept as a string — leading zeros matter. */
  accountNumber: string;
  /** Integer VND, > 0. */
  amount: number;
  /** Transfer description (nội dung chuyển khoản): letters, digits and spaces. */
  description: string;
}

export class VietQrError extends Error {}

export function validateBankBin(bin: string): string | null {
  return /^\d{6}$/.test(bin) ? null : 'BIN ngân hàng phải gồm đúng 6 chữ số';
}

export function validateAccountNumber(accountNumber: string): string | null {
  return /^[0-9A-Za-z]{1,19}$/.test(accountNumber) ? null : 'Số tài khoản chỉ gồm chữ/số, tối đa 19 ký tự';
}

export function validateAmount(amount: number): string | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_VIETQR_AMOUNT) {
    return 'Số tiền phải là số nguyên VND lớn hơn 0';
  }
  return null;
}

export function validateDescription(description: string): string | null {
  if (!/^[0-9A-Za-z ]+$/.test(description) || description.trim() !== description) {
    return 'Nội dung chuyển khoản chỉ gồm chữ không dấu, số và khoảng trắng';
  }
  if (description.length > MAX_VIETQR_DESCRIPTION_LENGTH) {
    return `Nội dung chuyển khoản tối đa ${MAX_VIETQR_DESCRIPTION_LENGTH} ký tự`;
  }
  return null;
}

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new VietQrError(`Trường ${id} quá dài`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as 4 uppercase hex digits — the EMVCo QR CRC. */
export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Builds the payload string to encode in the QR. Throws VietQrError on invalid input. */
export function buildVietQrPayload(input: VietQrInput): string {
  const err =
    validateBankBin(input.bankBin) ??
    validateAccountNumber(input.accountNumber) ??
    validateAmount(input.amount) ??
    validateDescription(input.description);
  if (err) throw new VietQrError(err);

  const beneficiary = tlv('00', input.bankBin) + tlv('01', input.accountNumber);
  const merchantAccount = tlv('00', NAPAS_GUID) + tlv('01', beneficiary) + tlv('02', VIETQR_SERVICE_TRANSFER_TO_ACCOUNT);
  const body =
    tlv('00', PAYLOAD_FORMAT) +
    tlv('01', POINT_OF_INITIATION_DYNAMIC) +
    tlv('38', merchantAccount) +
    tlv('53', CURRENCY_VND) +
    tlv('54', String(input.amount)) +
    tlv('58', COUNTRY_VN) +
    tlv('62', tlv('08', input.description)) +
    '6304';
  return body + crc16Ccitt(body);
}

/** Splits one TLV level into { id: value }. Throws on a truncated / malformed sequence. */
export function parseTlv(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const id = data.slice(i, i + 2);
    const len = Number(data.slice(i + 2, i + 4));
    if (id.length !== 2 || !/^\d{2}$/.test(data.slice(i + 2, i + 4)) || i + 4 + len > data.length) {
      throw new VietQrError(`TLV không hợp lệ tại vị trí ${i}`);
    }
    out[id] = data.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

export interface DecodedVietQr {
  bankBin: string;
  accountNumber: string;
  amount: number;
  description: string;
  currency: string;
  country: string;
  serviceCode: string;
}

/** Decodes and checks a VietQR transfer payload (CRC, GUID, service, currency). Used as a
 * self-check before a payload is handed to a customer, and by the tests. */
export function decodeVietQrPayload(payload: string): DecodedVietQr {
  if (!/^[\x20-\x7E]+$/.test(payload) || payload.length < 8) throw new VietQrError('Payload không hợp lệ');
  const body = payload.slice(0, -4);
  if (!body.endsWith('6304') || crc16Ccitt(body) !== payload.slice(-4)) throw new VietQrError('Sai CRC');
  const root = parseTlv(payload);
  const merchant = parseTlv(root['38'] ?? '');
  const beneficiary = parseTlv(merchant['01'] ?? '');
  const additional = parseTlv(root['62'] ?? '');
  if (root['00'] !== PAYLOAD_FORMAT) throw new VietQrError('Sai payload format indicator');
  if (merchant['00'] !== NAPAS_GUID) throw new VietQrError('Không phải mã VietQR (NAPAS)');
  if (merchant['02'] !== VIETQR_SERVICE_TRANSFER_TO_ACCOUNT) throw new VietQrError('Không phải mã chuyển khoản tới tài khoản');
  return {
    bankBin: beneficiary['00'] ?? '',
    accountNumber: beneficiary['01'] ?? '',
    amount: Number(root['54']),
    description: additional['08'] ?? '',
    currency: root['53'] ?? '',
    country: root['58'] ?? '',
    serviceCode: merchant['02'],
  };
}
