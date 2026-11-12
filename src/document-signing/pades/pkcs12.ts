import { BadRequestException } from '@nestjs/common';
import * as forge from 'node-forge';

/** Khoá ký + chứng thư số đọc từ file PKCS#12 (.p12 / .pfx) */
export interface SignerCredentials {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
  /** Chứng thư trung gian / gốc đi kèm trong file — nhúng vào CMS để phần mềm đọc PDF dựng được chuỗi */
  chain: forge.pki.Certificate[];
}

/** Thông tin chứng thư số an toàn để trả về FE (không chứa khoá) */
export interface CertificateSummary {
  subjectCN: string;
  issuerCN: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  /** notBefore <= hiện tại <= notAfter */
  currentlyValid: boolean;
}

/** Giới hạn kích thước file chứng thư — p12 thực tế chỉ vài KB */
export const MAX_PKCS12_SIZE = 100 * 1024;

const BAG_KEY = forge.pki.oids.pkcs8ShroudedKeyBag as string;
const BAG_KEY_PLAIN = forge.pki.oids.keyBag as string;
const BAG_CERT = forge.pki.oids.certBag as string;

function sameRsaPublicKey(key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate): boolean {
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  return !!pub?.n && pub.n.equals(key.n) && pub.e.equals(key.e);
}

/**
 * Đọc file PKCS#12 bằng node-forge. Chỉ hỗ trợ khoá RSA (toàn bộ CA công cộng tại Việt Nam —
 * VNPT-CA, Viettel-CA, BKAV-CA, FPT-CA… — đều cấp chứng thư RSA).
 *
 * Lưu ý: chữ ký số trên USB token KHÔNG xuất được khoá bí mật ra file .p12 — USB token vẫn dùng
 * luồng "ký ngoài hệ thống rồi tải lên". Luồng này dành cho chứng thư dạng file (.p12/.pfx).
 */
export function loadPkcs12(buffer: Buffer, password: string): SignerCredentials {
  if (!buffer?.length) throw new BadRequestException('Vui lòng chọn file chứng thư số (.p12 / .pfx)');
  if (buffer.length > MAX_PKCS12_SIZE) throw new BadRequestException('File chứng thư số quá lớn');

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password ?? '');
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (/mac could not be verified|invalid password/i.test(msg)) {
      throw new BadRequestException('Mật khẩu chứng thư số không đúng');
    }
    if (/unsupported/i.test(msg)) {
      throw new BadRequestException(`File chứng thư số dùng thuật toán mã hoá chưa được hỗ trợ (${msg})`);
    }
    throw new BadRequestException('File chứng thư số không hợp lệ (cần định dạng PKCS#12 .p12 / .pfx)');
  }

  const keys: forge.pki.rsa.PrivateKey[] = [];
  const certs: forge.pki.Certificate[] = [];
  try {
    for (const bagType of [BAG_KEY, BAG_KEY_PLAIN]) {
      for (const bag of p12.getBags({ bagType })[bagType] ?? []) {
        if (bag.key) keys.push(bag.key as forge.pki.rsa.PrivateKey);
      }
    }
    for (const bag of p12.getBags({ bagType: BAG_CERT })[BAG_CERT] ?? []) {
      if (bag.cert) certs.push(bag.cert);
    }
  } catch {
    throw new BadRequestException('Không đọc được khoá trong chứng thư số — chỉ hỗ trợ khoá RSA');
  }

  if (keys.length === 0) {
    throw new BadRequestException(
      'File chứng thư số không chứa khoá bí mật (hoặc khoá không phải RSA) — không thể dùng để ký',
    );
  }
  for (const key of keys) {
    const certificate = certs.find((c) => sameRsaPublicKey(key, c));
    if (certificate) {
      return { privateKey: key, certificate, chain: certs.filter((c) => c !== certificate) };
    }
  }
  throw new BadRequestException('Không tìm thấy chứng thư khớp với khoá bí mật trong file');
}

/**
 * CN của subject/issuer. Khi PARSE chứng thư, node-forge trả UTF8String dưới dạng chuỗi byte UTF-8
 * thô (VD "QUÃ\u0081CH…") — chứng thư CA Việt Nam ghi tên có dấu bằng UTF8String nên phải decode.
 */
export function certCommonName(name: forge.pki.Certificate['subject']): string {
  const field = name.getField('CN') as { value?: string; valueTagClass?: number } | null;
  const value = field?.value ?? '';
  if (field?.valueTagClass === forge.asn1.Type.UTF8) {
    try {
      return forge.util.decodeUtf8(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function summarizeCertificate(cert: forge.pki.Certificate, now = new Date()): CertificateSummary {
  return {
    subjectCN: certCommonName(cert.subject),
    issuerCN: certCommonName(cert.issuer),
    serialNumber: cert.serialNumber ?? '',
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    currentlyValid: now >= cert.validity.notBefore && now <= cert.validity.notAfter,
  };
}

/** Chứng thư hết hạn / chưa đến hạn thì không ký — chữ ký sẽ bị mọi phần mềm báo không hợp lệ */
export function assertCertificateUsable(cert: forge.pki.Certificate, now = new Date()): void {
  const s = summarizeCertificate(cert, now);
  if (now < s.notBefore) throw new BadRequestException('Chứng thư số chưa đến ngày hiệu lực');
  if (now > s.notAfter) throw new BadRequestException('Chứng thư số đã hết hạn — vui lòng gia hạn với nhà cung cấp');
}
