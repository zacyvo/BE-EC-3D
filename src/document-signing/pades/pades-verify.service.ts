import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { PadesSignatureInfo } from './pades.types';

/**
 * SignerInfo ASN.1 validator (RFC 2315 / RFC 5652) — node-forge có định nghĩa tương đương
 * trong lib/pkcs7asn1.js nhưng KHÔNG export ra ngoài, nên khai báo lại tối thiểu phần cần dùng
 * để capture digestAlgorithm / authenticatedAttributes / signatureAlgorithm / signature.
 */
const SIGNER_INFO_VALIDATOR = {
  name: 'SignerInfo',
  tagClass: forge.asn1.Class.UNIVERSAL,
  type: forge.asn1.Type.SEQUENCE,
  constructed: true,
  value: [
    { name: 'SignerInfo.version', tagClass: forge.asn1.Class.UNIVERSAL, type: forge.asn1.Type.INTEGER, constructed: false },
    {
      name: 'SignerInfo.issuerAndSerialNumber',
      tagClass: forge.asn1.Class.UNIVERSAL,
      type: forge.asn1.Type.SEQUENCE,
      constructed: true,
      value: [],
    },
    {
      name: 'SignerInfo.digestAlgorithm',
      tagClass: forge.asn1.Class.UNIVERSAL,
      type: forge.asn1.Type.SEQUENCE,
      constructed: true,
      value: [
        {
          name: 'SignerInfo.digestAlgorithm.algorithm',
          tagClass: forge.asn1.Class.UNIVERSAL,
          type: forge.asn1.Type.OID,
          constructed: false,
          capture: 'digestAlgorithm',
        },
      ],
    },
    {
      name: 'SignerInfo.authenticatedAttributes',
      tagClass: forge.asn1.Class.CONTEXT_SPECIFIC,
      type: 0,
      constructed: true,
      optional: true,
      capture: 'authenticatedAttributes',
    },
    {
      name: 'SignerInfo.digestEncryptionAlgorithm',
      tagClass: forge.asn1.Class.UNIVERSAL,
      type: forge.asn1.Type.SEQUENCE,
      constructed: true,
      capture: 'signatureAlgorithm',
    },
    {
      name: 'SignerInfo.encryptedDigest',
      tagClass: forge.asn1.Class.UNIVERSAL,
      type: forge.asn1.Type.OCTETSTRING,
      constructed: false,
      capture: 'signature',
    },
  ],
};

const DIGEST_TO_NODE_ALGO: Record<string, string> = {
  sha1: 'RSA-SHA1',
  sha256: 'RSA-SHA256',
  sha384: 'RSA-SHA384',
  sha512: 'RSA-SHA512',
};

const ATTR_OID_MESSAGE_DIGEST = forge.pki.oids.messageDigest as string; // 1.2.840.113549.1.9.4
const ATTR_OID_SIGNING_TIME = forge.pki.oids.signingTime as string; // 1.2.840.113549.1.9.5

interface ParsedAttribute {
  oid: string;
  valueNode: forge.asn1.Asn1;
}

@Injectable()
export class PadesVerifyService {
  private readonly logger = new Logger(PadesVerifyService.name);

  /** Tìm tất cả chữ ký PAdES/CMS nhúng trong PDF (theo thứ tự ký — cũ nhất trước). */
  verify(pdfBuffer: Buffer): PadesSignatureInfo[] {
    // Dùng 'latin1' để 1 ký tự = 1 byte, giữ đúng offset khớp với /ByteRange trong file gốc.
    const text = pdfBuffer.toString('latin1');
    const byteRangeRegex = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
    const results: PadesSignatureInfo[] = [];

    let match: RegExpExecArray | null;
    while ((match = byteRangeRegex.exec(text)) !== null) {
      const start1 = Number(match[1]);
      const len1 = Number(match[2]);
      const start2 = Number(match[3]);
      const len2 = Number(match[4]);

      const byteRangeValid =
        start1 === 0 &&
        len1 > 0 &&
        start2 > start1 + len1 &&
        len2 > 0 &&
        start2 + len2 <= pdfBuffer.length;

      if (!byteRangeValid) {
        this.logger.warn(`Bỏ qua /ByteRange không hợp lệ tại vị trí ${match.index}`);
        continue;
      }

      const gap = text.slice(start1 + len1, start2);
      const ltIdx = gap.indexOf('<');
      const gtIdx = gap.indexOf('>');
      if (ltIdx === -1 || gtIdx === -1 || gtIdx <= ltIdx) {
        this.logger.warn('Không tìm thấy /Contents hợp lệ tương ứng với /ByteRange');
        continue;
      }
      const hex = gap.slice(ltIdx + 1, gtIdx).replace(/[^0-9a-fA-F]/g, '');
      const derBytes = Buffer.from(hex, 'hex');

      const subFilterWindow = text.slice(Math.max(0, match.index - 3000), match.index);
      const subFilterMatch = /\/SubFilter\s*\/([A-Za-z0-9.]+)/.exec(subFilterWindow);

      const signedContent = Buffer.concat([
        pdfBuffer.subarray(start1, start1 + len1),
        pdfBuffer.subarray(start2, start2 + len2),
      ]);

      const coversToEndOfFile = start2 + len2 === pdfBuffer.length;

      results.push(
        this.verifyOne(derBytes, signedContent, {
          byteRangeValid,
          coversToEndOfFile,
          subFilter: subFilterMatch?.[1] ?? '',
        }),
      );
    }

    return results;
  }

  private verifyOne(
    derBytes: Buffer,
    signedContent: Buffer,
    meta: { byteRangeValid: boolean; coversToEndOfFile: boolean; subFilter: string },
  ): PadesSignatureInfo {
    const base: PadesSignatureInfo = {
      byteRangeValid: meta.byteRangeValid,
      coversToEndOfFile: meta.coversToEndOfFile,
      digestValid: false,
      signatureValid: false,
      signerCertCN: '',
      signerCertSerial: '',
      signerCertIssuer: '',
      certCurrentlyValid: false,
      subFilter: meta.subFilter,
      rawCertPem: '',
      chainValidated: false,
    };

    let p7: forge.pkcs7.Captured<forge.pkcs7.PkcsSignedData>;
    try {
      // parseAllBytes:false — /Contents luôn được cấp phát dư chỗ và đệm bằng byte 0x00 phía sau
      // DER thật (chỗ trống để chèn chữ ký), nên luôn còn dư byte sau khi parse xong SEQUENCE ngoài cùng.
      const asn1Obj = forge.asn1.fromDer(
        forge.util.createBuffer(derBytes.toString('binary')),
        { parseAllBytes: false } as unknown as boolean,
      );
      p7 = forge.pkcs7.messageFromAsn1(asn1Obj) as forge.pkcs7.Captured<forge.pkcs7.PkcsSignedData>;
    } catch (err) {
      this.logger.warn(`Không parse được CMS/PKCS#7: ${(err as Error).message}`);
      return base;
    }

    const signerInfosRaw = (p7 as any).rawCapture?.signerInfos;
    const firstSignerAsn1 = Array.isArray(signerInfosRaw) ? signerInfosRaw[0] : undefined;
    if (!firstSignerAsn1) {
      this.logger.warn('CMS không có SignerInfo');
      return base;
    }

    const signerCapture: Record<string, unknown> = {};
    const validateErrors: string[] = [];
    const validated = (forge.asn1 as any).validate(
      firstSignerAsn1,
      SIGNER_INFO_VALIDATOR,
      signerCapture,
      validateErrors,
    );
    if (!validated) {
      this.logger.warn(`Không parse được SignerInfo: ${validateErrors.join('; ')}`);
      return base;
    }

    const digestAlgorithmOid = forge.asn1.derToOid(signerCapture.digestAlgorithm as string);
    const digestName = (forge.pki.oids as Record<string, string>)[digestAlgorithmOid];
    const nodeRsaAlgo = digestName ? DIGEST_TO_NODE_ALGO[digestName] : undefined;

    const signatureBytes = Buffer.from(signerCapture.signature as string, 'binary');

    // Certificates nhúng trong CMS — chọn cert mà public key verify thành công (không so khớp
    // issuer/serial thủ công để tránh phải tự so sánh ASN.1 Name — xem giới hạn trong pades.types.ts).
    const certificates = p7.certificates ?? [];

    const authAttrsNodes = signerCapture.authenticatedAttributes as forge.asn1.Asn1[] | undefined;
    let signedAttrsDer: Buffer | undefined;
    let messageDigestHex: string | undefined;
    let signingTime: Date | undefined;

    if (Array.isArray(authAttrsNodes)) {
      const attrs = this.parseAttributes(authAttrsNodes);
      const digestAttr = attrs.find((a) => a.oid === ATTR_OID_MESSAGE_DIGEST);
      if (digestAttr) {
        const octetNode = this.firstSetValue(digestAttr.valueNode);
        if (octetNode) {
          messageDigestHex = Buffer.from(octetNode.value as string, 'binary').toString('hex');
        }
      }
      const timeAttr = attrs.find((a) => a.oid === ATTR_OID_SIGNING_TIME);
      if (timeAttr) {
        const timeNode = this.firstSetValue(timeAttr.valueNode);
        if (timeNode) {
          try {
            signingTime =
              timeNode.type === forge.asn1.Type.GENERALIZEDTIME
                ? forge.asn1.generalizedTimeToDate(timeNode.value as string)
                : forge.asn1.utcTimeToDate(timeNode.value as string);
          } catch {
            /* signingTime không bắt buộc — bỏ qua nếu parse lỗi */
          }
        }
      }

      // DER re-encode: tag [0] IMPLICIT -> UNIVERSAL SET (bắt buộc theo RFC 5652 §5.4 khi verify)
      const setNode = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrsNodes);
      signedAttrsDer = Buffer.from(forge.asn1.toDer(setNode).getBytes(), 'binary');
    }

    // digestValid: hash nội dung PDF thực sự bị ký, so với messageDigest attribute
    if (digestName && messageDigestHex) {
      const actualDigestHex = crypto.createHash(digestName).update(signedContent).digest('hex');
      base.digestValid = actualDigestHex === messageDigestHex;
    }

    // signatureValid: verify RSA signature trên DER(signedAttrs) bằng public key của cert
    let matchedCert: forge.pki.Certificate | undefined;
    if (signedAttrsDer && nodeRsaAlgo && certificates.length > 0) {
      for (const cert of certificates) {
        try {
          const pubKeyPem = forge.pki.publicKeyToPem(cert.publicKey);
          const ok = crypto.createVerify(nodeRsaAlgo).update(signedAttrsDer).verify(pubKeyPem, signatureBytes);
          if (ok) {
            matchedCert = cert;
            base.signatureValid = true;
            break;
          }
        } catch (err) {
          this.logger.warn(`Verify chữ ký với 1 certificate ứng viên thất bại: ${(err as Error).message}`);
        }
      }
    }
    if (!matchedCert) matchedCert = certificates[0];

    if (matchedCert) {
      base.signerCertCN = matchedCert.subject.getField('CN')?.value ?? '';
      base.signerCertIssuer = matchedCert.issuer.getField('CN')?.value ?? '';
      base.signerCertSerial = matchedCert.serialNumber ?? '';
      base.certNotBefore = matchedCert.validity.notBefore;
      base.certNotAfter = matchedCert.validity.notAfter;
      const now = new Date();
      base.certCurrentlyValid = now >= matchedCert.validity.notBefore && now <= matchedCert.validity.notAfter;
      try {
        base.rawCertPem = forge.pki.certificateToPem(matchedCert);
      } catch {
        base.rawCertPem = '';
      }
    }

    base.signingTime = signingTime;
    return base;
  }

  private parseAttributes(nodes: forge.asn1.Asn1[]): ParsedAttribute[] {
    const attrs: ParsedAttribute[] = [];
    for (const node of nodes) {
      const children = node.value;
      if (!Array.isArray(children) || children.length < 2) continue;
      const [oidNode, setNode] = children;
      try {
        const oid = forge.asn1.derToOid(oidNode.value as string);
        attrs.push({ oid, valueNode: setNode });
      } catch {
        /* skip malformed attribute */
      }
    }
    return attrs;
  }

  private firstSetValue(setNode: forge.asn1.Asn1): forge.asn1.Asn1 | undefined {
    const value = setNode.value;
    return Array.isArray(value) ? value[0] : undefined;
  }
}
