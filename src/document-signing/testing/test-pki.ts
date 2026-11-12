import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import * as pdfMake from 'pdfmake';

/** CHỈ dùng trong test: tạo file PKCS#12 chứa chứng thư tự ký RSA-2048 */
export function makeTestP12(
  cn: string,
  password: string,
  validity: { notBefore?: Date; notAfter?: Date; issuerCN?: string } = {},
): Buffer {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b2c3d';
  cert.validity.notBefore = validity.notBefore ?? new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = validity.notAfter ?? new Date(Date.now() + 365 * 24 * 3600_000);
  // Tên có dấu: CA Việt Nam ghi CN dạng UTF8String
  cert.setSubject([
    { name: 'commonName', value: cn, valueTagClass: forge.asn1.Type.UTF8 },
    { name: 'countryName', value: 'VN' },
  ] as unknown as forge.pki.CertificateField[]);
  cert.setIssuer([
    { name: 'commonName', value: validity.issuerCN ?? 'Test CA', valueTagClass: forge.asn1.Type.UTF8 },
  ] as unknown as forge.pki.CertificateField[]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/**
 * Thư mục pdf-generation/fonts có thể trống ở máy dev (file TTF không đi kèm source) — khi đó
 * trỏ pdfmake sang Roboto đi kèm package (Medium thay Bold) để vẫn sinh được PDF hợp đồng thật.
 */
export function useBundledFontsIfMissing(): void {
  const own = path.join(__dirname, '..', 'pdf-generation', 'fonts', 'Roboto-Regular.ttf');
  if (fs.existsSync(own)) return;
  const dir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
  pdfMake.setFonts({
    Roboto: {
      normal: path.join(dir, 'Roboto-Regular.ttf'),
      bold: path.join(dir, 'Roboto-Medium.ttf'),
      italics: path.join(dir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
    },
  });
  pdfMake.setLocalAccessPolicy((p: string) => p.startsWith(dir));
}
