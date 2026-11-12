import { BadRequestException } from '@nestjs/common';
import * as forge from 'node-forge';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { ContractPdfInput } from '../pdf-generation/contract-pdf.definition';
import { PadesSignService } from './pades-sign.service';
import { PadesVerifyService } from './pades-verify.service';
import { SignaturePlacementService } from './signature-placement.service';
import { TamperCheckService } from './tamper-check.service';
import { loadPkcs12, SignerCredentials } from './pkcs12';
import { makeTestP12 as makeP12, useBundledFontsIfMissing } from '../testing/test-pki';

/**
 * Chạy: NODE_OPTIONS=--experimental-vm-modules npx jest pades-sign (pdfjs-dist là ESM-only).
 *
 * Ký số PAdES trên server — dùng PDF hợp đồng THẬT do pdfmake sinh ra + chứng thư tự ký sinh trong
 * test, rồi xác thực lại bằng chính PadesVerifyService / TamperCheckService của luồng upload.
 */
jest.setTimeout(60_000);

const input: ContractPdfInput = {
  template: 'DEFAULT',
  contractNo: '0001/HĐ-2026',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  items: [{ productCode: 'ABC123', productName: 'Đèn in 3D', quantity: 2, unitPrice: 500_000, subtotal: 1_000_000 }],
  totalAmount: 1_000_000,
  partyA: { name: 'Nguyễn Văn A', address: 'Q1', representative: 'Nguyễn Văn A', position: '', phone: '0900000000', email: '', taxCode: '' },
  partyB: { name: 'Luxe Glow', address: 'Tân Phú', representative: 'Quách Phương Thanh Trúc', position: 'Giám đốc', phone: '', email: '', taxCode: '' },
  signPlace: 'TP. Hồ Chí Minh',
  signDate: new Date('2026-11-02T00:00:00Z'),
  technicalRequirements: '',
  paymentSchedule: [{ percent: 100, timing: 'ngay khi ký hợp đồng' }],
  bankAccountNumber: '1',
  bankName: 'VPBANK',
  bankAccountHolder: 'LUXE GLOW',
  deliveryAddress: 'Q1',
} as ContractPdfInput;

describe('PadesSignService', () => {
  const signer = new PadesSignService();
  const verifier = new PadesVerifyService();
  const placement = new SignaturePlacementService();
  const tamper = new TamperCheckService();
  let unsigned: Buffer;
  let partyB: SignerCredentials;
  let partyA: SignerCredentials;

  beforeAll(async () => {
    useBundledFontsIfMissing();
    unsigned = await new PdfGenerationService().generateContractPdf(input);
    partyB = loadPkcs12(makeP12('QUÁCH PHƯƠNG THANH TRÚC', 'secret-b'), 'secret-b');
    partyA = loadPkcs12(makeP12('NGUYỄN VĂN A', 'secret-a'), 'secret-a');
  });

  it('đặt khung chữ ký dưới dòng "ĐẠI DIỆN BÊN B" của template', async () => {
    const box = await placement.resolve(unsigned, 'B');
    expect(box.anchored).toBe(true);
    const [x1, y1, x2, y2] = box.rect;
    expect(x2 - x1).toBeGreaterThan(100);
    expect(y2 - y1).toBeGreaterThanOrEqual(34);
    expect(x1).toBeGreaterThan(297 - 100); // nửa phải trang A4 (cột Bên B)
  });

  it('ký 1 lần: incremental (giữ nguyên byte gốc) và chữ ký hợp lệ', async () => {
    const appearance = await placement.resolve(unsigned, 'B');
    const signed = await signer.sign(unsigned, {
      credentials: partyB,
      reason: 'Ký hợp đồng số 0001/HĐ-2026',
      location: 'TP. Hồ Chí Minh',
      appearance,
    });

    expect(signed.subarray(0, unsigned.length).equals(unsigned)).toBe(true);
    await expect(tamper.assertIncrementalOnly(unsigned, signed)).resolves.toBeUndefined();

    const sigs = verifier.verify(signed);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({
      byteRangeValid: true,
      coversToEndOfFile: true,
      digestValid: true,
      signatureValid: true,
      signerCertCN: 'QUÁCH PHƯƠNG THANH TRÚC',
      subFilter: 'adbe.pkcs7.detached',
    });
    expect(sigs[0].signingTime).toBeInstanceOf(Date);

    // pdf-lib đọc lại được: có đúng 1 field chữ ký
    const reloaded = await PDFDocument.load(signed, { updateMetadata: false });
    expect(reloaded.getForm().getFields().map((f) => f.constructor.name)).toEqual(['PDFSignature']);
  });

  it('ký chồng (Bên B rồi Bên A): cả 2 chữ ký đều hợp lệ', async () => {
    const signedB = await signer.sign(unsigned, { credentials: partyB, appearance: await placement.resolve(unsigned, 'B') });
    const signedAB = await signer.sign(signedB, { credentials: partyA, appearance: await placement.resolve(signedB, 'A') });

    expect(signedAB.subarray(0, signedB.length).equals(signedB)).toBe(true);
    const sigs = verifier.verify(signedAB);
    expect(sigs).toHaveLength(2);
    expect(sigs.every((s) => s.digestValid && s.signatureValid)).toBe(true);
    expect(sigs[0].coversToEndOfFile).toBe(false);
    expect(sigs[1].coversToEndOfFile).toBe(true);
    expect(sigs.map((s) => s.signerCertCN)).toEqual(['QUÁCH PHƯƠNG THANH TRÚC', 'NGUYỄN VĂN A']);
  });

  it('ký được PDF dùng xref stream / object stream (file import từ Word, Acrobat…)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawText('Contract imported', { x: 50, y: 700, font: await doc.embedFont(StandardFonts.Helvetica) });
    const pdf = Buffer.from(await doc.save({ useObjectStreams: true }));
    expect(pdf.toString('latin1')).toContain('/XRef');

    const box = await placement.resolve(pdf, 'B');
    expect(box.anchored).toBe(false); // không có khối ký → góc dưới phải trang cuối
    const signed = await signer.sign(pdf, { credentials: partyB, appearance: box });
    const sigs = verifier.verify(signed);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].digestValid && sigs[0].signatureValid && sigs[0].coversToEndOfFile).toBe(true);
    await expect(PDFDocument.load(signed, { updateMetadata: false })).resolves.toBeDefined();
  });

  it('chữ ký ẩn (không hiển thị trên trang) vẫn hợp lệ', async () => {
    const signed = await signer.sign(unsigned, { credentials: partyB, appearance: null });
    const [sig] = verifier.verify(signed);
    expect(sig.digestValid && sig.signatureValid).toBe(true);
  });

  it('SignerInfo dùng đúng issuer DER của chứng thư khi tên CA có dấu (lỗi double-UTF8 của node-forge)', async () => {
    const creds = loadPkcs12(makeP12('TRẦN THỊ B', 'pw', { issuerCN: 'CA Thử Nghiệm Việt Nam' }), 'pw');
    const signed = await signer.sign(unsigned, { credentials: creds, appearance: null });

    const text = signed.toString('latin1');
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)/.exec(text)!;
    const hex = text.slice(Number(m[2]) + 1, Number(m[3]) - 1).replace(/(00)+$/, '');
    const cms = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(hex, 'hex').toString('binary')), {
      parseAllBytes: false,
    } as unknown as boolean);
    const signedData = ((cms.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    const signerInfo = (signedData[signedData.length - 1].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
    const issuerInSignerInfo = (signerInfo[1].value as forge.asn1.Asn1[])[0];

    const certIssuer = forge.pki.distinguishedNameToAsn1(creds.certificate.issuer);
    const tbs = (creds.certificate as unknown as { tbsCertificate: forge.asn1.Asn1 }).tbsCertificate;
    const tbsIssuer = (tbs.value as forge.asn1.Asn1[])[3];
    const der = (n: forge.asn1.Asn1) => forge.asn1.toDer(n).getBytes();
    expect(der(issuerInSignerInfo)).toBe(der(tbsIssuer));
    // bằng chứng lỗi gốc: forge dựng lại DN từ field đã parse sẽ ra byte khác
    expect(der(certIssuer)).not.toBe(der(tbsIssuer));
    expect(verifier.verify(signed)[0].signerCertIssuer).toBe('CA Thử Nghiệm Việt Nam');
  });

  it('báo lỗi rõ ràng khi sai mật khẩu chứng thư', () => {
    const p12 = makeP12('X', 'right');
    expect(() => loadPkcs12(p12, 'wrong')).toThrow(BadRequestException);
    expect(() => loadPkcs12(p12, 'wrong')).toThrow('Mật khẩu chứng thư số không đúng');
  });
});
