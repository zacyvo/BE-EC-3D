import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFOperator,
  PDFRef,
  PDFString,
  beginText,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
} from 'pdf-lib';
import { certCommonName, SignerCredentials } from './pkcs12';

// @pdf-lib/fontkit là bundle UMD (module.exports = fontkit) — dự án không bật esModuleInterop nên
// `import fontkit from` sẽ ra undefined lúc chạy; require trực tiếp để lấy đúng object.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fontkit = require('@pdf-lib/fontkit');

const FONTS_DIR = path.join(__dirname, '..', 'pdf-generation', 'fonts');

/**
 * Dung lượng dành sẵn cho CMS trong /Contents (byte). CMS gồm chữ ký RSA + chứng thư ký + các
 * chứng thư trung gian nhúng kèm — với chuỗi 3 chứng thư RSA-4096 vẫn < 10KB.
 */
const SIGNATURE_MAX_BYTES = 16_384;
const BYTE_RANGE_PLACEHOLDER = `[0 ${'0'.repeat(10)} ${'0'.repeat(10)} ${'0'.repeat(10)}]`;

/** Vị trí hiển thị chữ ký trên trang (toạ độ PDF user space, gốc ở góc dưới-trái) */
export interface SignatureAppearance {
  pageIndex: number;
  rect: [number, number, number, number];
}

export interface PadesSignOptions {
  credentials: SignerCredentials;
  reason?: string;
  location?: string;
  signingTime?: Date;
  /** null/undefined → chữ ký ẩn (không có hình trên trang) */
  appearance?: SignatureAppearance | null;
  /** Tiền tố tên field chữ ký trong AcroForm (chỉ ASCII) */
  fieldNamePrefix?: string;
}

interface XrefEntry {
  num: number;
  gen: number;
  offset: number;
}

/** PDF text string dạng UTF-16BE có BOM — bắt buộc để chứa tiếng Việt có dấu */
function pdfTextHex(text: string): string {
  const utf16be = Buffer.from(text, 'utf16le').swap16();
  return `<FEFF${utf16be.toString('hex').toUpperCase()}>`;
}

function pdfDate(date: Date): string {
  const iso = date.toISOString(); // 2026-11-12T03:04:05.000Z
  return `(D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z)`;
}

function formatVnDateTime(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function serializeObject(obj: PDFObject): Buffer {
  const bytes = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(bytes, 0);
  return Buffer.from(bytes);
}

/**
 * Ký số PAdES (CMS detached, SubFilter adbe.pkcs7.detached, SHA-256/RSA) trực tiếp trên server.
 *
 * Chữ ký được ghi dưới dạng INCREMENTAL UPDATE: toàn bộ byte của file gốc giữ nguyên, chỉ nối
 * thêm 1 revision (field chữ ký + widget + hình chữ ký + /Sig dict + xref mới). Nhờ vậy:
 *  - các chữ ký số đã có trước đó trong file vẫn hợp lệ (ký chồng nhiều bên),
 *  - TamperCheckService.assertIncrementalOnly khớp byte-for-byte với bản gốc.
 *
 * pdf-lib chỉ được dùng để ĐỌC cấu trúc (catalog, trang, AcroForm) và dựng các object mới — KHÔNG
 * gọi pdfDoc.save() (save sẽ ghi lại toàn bộ file, phá chữ ký cũ và lệch byte so với bản gốc).
 */
@Injectable()
export class PadesSignService {
  private readonly logger = new Logger(PadesSignService.name);
  private fontCache?: { regular: Buffer; bold: Buffer };

  /**
   * Font cho hình chữ ký (cần glyph tiếng Việt). Ưu tiên Roboto trong pdf-generation/fonts (dùng
   * chung với PDF hợp đồng); thiếu file thì dùng bản Roboto đi kèm package pdfmake.
   */
  private fonts() {
    if (!this.fontCache) {
      const pick = (...candidates: string[]) => {
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) throw new InternalServerErrorException('Thiếu font Roboto để dựng hình chữ ký số');
        return fs.readFileSync(found);
      };
      const bundled = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
      this.fontCache = {
        regular: pick(path.join(FONTS_DIR, 'Roboto-Regular.ttf'), path.join(bundled, 'Roboto-Regular.ttf')),
        bold: pick(
          path.join(FONTS_DIR, 'Roboto-Bold.ttf'),
          path.join(bundled, 'Roboto-Medium.ttf'),
          path.join(bundled, 'Roboto-Regular.ttf'),
        ),
      };
    }
    return this.fontCache;
  }

  async sign(pdf: Buffer, options: PadesSignOptions): Promise<Buffer> {
    if (pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('File không phải định dạng PDF hợp lệ');
    }
    const signingTime = options.signingTime ?? new Date();
    const { certificate } = options.credentials;
    const signerCN = certCommonName(certificate.subject);
    const issuerCN = certCommonName(certificate.issuer);

    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(pdf, { updateMetadata: false });
    } catch (err) {
      if ((err as Error)?.name === 'EncryptedPDFError' || /encrypted/i.test((err as Error)?.message ?? '')) {
        throw new BadRequestException('File PDF đang được mã hoá / đặt mật khẩu — không thể ký số');
      }
      throw new BadRequestException('Không đọc được cấu trúc file PDF để ký số');
    }
    if (doc.isEncrypted) {
      throw new BadRequestException('File PDF đang được mã hoá / đặt mật khẩu — không thể ký số');
    }

    const ctx = doc.context;
    const prev = this.readPreviousXref(pdf);
    const firstNewObjectNumber = Math.max(prev.size, ctx.largestObjectNumber + 1);
    ctx.largestObjectNumber = firstNewObjectNumber - 1;

    const catalogRef = ctx.trailerInfo.Root;
    if (!(catalogRef instanceof PDFRef)) {
      throw new BadRequestException('Cấu trúc file PDF không hợp lệ (thiếu catalog)');
    }
    const pages = doc.getPages();
    if (pages.length === 0) throw new BadRequestException('File PDF không có trang nào');
    const appearance = options.appearance ?? null;
    const pageIndex = Math.min(Math.max(appearance?.pageIndex ?? pages.length - 1, 0), pages.length - 1);
    const page = pages[pageIndex];

    /** Object có sẵn (số hiệu < firstNewObjectNumber) bị sửa — cần ghi lại trong revision mới */
    const modified = new Map<number, PDFRef>();
    const markModified = (ref: PDFRef) => modified.set(ref.objectNumber, ref);

    // /Sig dict ghi tay (cần kiểm soát chính xác vị trí byte của /ByteRange & /Contents)
    const sigRef = ctx.nextRef();

    // ── Hình chữ ký (appearance stream) ─────────────────────────────────────
    let apRef: PDFRef | undefined;
    let rect: [number, number, number, number] = [0, 0, 0, 0];
    if (appearance) {
      rect = appearance.rect;
      doc.registerFontkit(fontkit);
      const { regular, bold } = this.fonts();
      const fontRegular = await doc.embedFont(regular, { subset: true });
      const fontBold = await doc.embedFont(bold, { subset: true });
      const lines: { text: string; font: PDFFont; name: string }[] = [
        { text: `Ký bởi: ${signerCN || '—'}`, font: fontBold, name: 'F2' },
        { text: `Ngày ký: ${formatVnDateTime(signingTime)}`, font: fontRegular, name: 'F1' },
      ];
      if (options.reason) lines.push({ text: `Lý do: ${options.reason}`, font: fontRegular, name: 'F1' });
      if (issuerCN) lines.push({ text: `Chứng thư: ${issuerCN}`, font: fontRegular, name: 'F1' });
      const apStream = this.buildAppearanceStream(doc, rect, lines, {
        F1: fontRegular.ref,
        F2: fontBold.ref,
      });
      apRef = ctx.register(apStream);
    }

    // ── Field chữ ký + widget annotation ────────────────────────────────────
    const fieldName = `${options.fieldNamePrefix ?? 'Signature'}_${signingTime.getTime()}`;
    const widget = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of(fieldName),
      V: sigRef,
      Rect: rect,
      F: 132, // Print + Locked
      P: page.ref,
      ...(apRef ? { AP: { N: apRef } } : {}),
    });
    const widgetRef = ctx.register(widget);

    const annots = page.node.get(PDFName.of('Annots'));
    if (annots instanceof PDFRef) {
      ctx.lookup(annots, PDFArray).push(widgetRef);
      markModified(annots);
    } else if (annots instanceof PDFArray) {
      annots.push(widgetRef);
      markModified(page.ref);
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
      markModified(page.ref);
    }

    const catalog = doc.catalog;
    const acroFormEntry = catalog.get(PDFName.of('AcroForm'));
    let acroForm: PDFDict;
    if (acroFormEntry instanceof PDFRef) {
      acroForm = ctx.lookup(acroFormEntry, PDFDict);
      markModified(acroFormEntry);
    } else if (acroFormEntry instanceof PDFDict) {
      acroForm = acroFormEntry;
      markModified(catalogRef);
    } else {
      acroForm = ctx.obj({ Fields: [] });
      catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));
      markModified(catalogRef);
    }
    const fields = acroForm.get(PDFName.of('Fields'));
    if (fields instanceof PDFRef) {
      ctx.lookup(fields, PDFArray).push(widgetRef);
      markModified(fields);
    } else if (fields instanceof PDFArray) {
      fields.push(widgetRef);
    } else {
      acroForm.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
    }
    acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); // SignaturesExist + AppendOnly

    // Nhúng font (subset) — pdf-lib chỉ ghi object font khi flush
    await doc.flush();

    // ── Ghi revision mới ────────────────────────────────────────────────────
    const toWrite = new Map<number, [PDFRef, PDFObject]>();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.objectNumber >= firstNewObjectNumber || modified.has(ref.objectNumber)) {
        toWrite.set(ref.objectNumber, [ref, obj]);
      }
    }
    for (const ref of modified.values()) {
      if (!toWrite.has(ref.objectNumber)) toWrite.set(ref.objectNumber, [ref, ctx.lookup(ref)!]);
    }

    const chunks: Buffer[] = [];
    let offset = pdf.length;
    const append = (b: Buffer) => {
      chunks.push(b);
      offset += b.length;
    };
    const lastByte = pdf[pdf.length - 1];
    if (lastByte !== 0x0a && lastByte !== 0x0d) append(Buffer.from('\n', 'latin1'));

    const entries: XrefEntry[] = [];
    for (const [ref, obj] of [...toWrite.values()].sort((a, b) => a[0].objectNumber - b[0].objectNumber)) {
      entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset });
      append(
        Buffer.concat([
          Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, 'latin1'),
          serializeObject(obj),
          Buffer.from('\nendobj\n', 'latin1'),
        ]),
      );
    }

    const sigParts = [
      `${sigRef.objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached`,
      ` /Name ${pdfTextHex(signerCN)}`,
      options.reason ? ` /Reason ${pdfTextHex(options.reason)}` : '',
      options.location ? ` /Location ${pdfTextHex(options.location)}` : '',
      ` /M ${pdfDate(signingTime)}`,
      ' /ByteRange ',
    ];
    const sigHead = sigParts.join('');
    const contentsHex = '0'.repeat(SIGNATURE_MAX_BYTES * 2);
    const sigObj = `${sigHead}${BYTE_RANGE_PLACEHOLDER} /Contents <${contentsHex}> >>\nendobj\n`;
    const sigObjOffset = offset;
    const byteRangePos = sigObjOffset + sigHead.length;
    const contentsStart = byteRangePos + BYTE_RANGE_PLACEHOLDER.length + ' /Contents '.length; // vị trí '<'
    const contentsEnd = contentsStart + contentsHex.length + 2; // ngay sau '>'
    entries.push({ num: sigRef.objectNumber, gen: 0, offset: sigObjOffset });
    append(Buffer.from(sigObj, 'latin1'));

    const xrefOffset = offset;
    append(this.buildXrefSection(ctx, prev, entries, xrefOffset, catalogRef));

    const out = Buffer.concat([pdf, ...chunks]);

    // ── Điền /ByteRange rồi ký ──────────────────────────────────────────────
    const byteRange = `[0 ${contentsStart} ${contentsEnd} ${out.length - contentsEnd}]`;
    if (byteRange.length > BYTE_RANGE_PLACEHOLDER.length) {
      throw new BadRequestException('File PDF quá lớn để ký số');
    }
    out.write(byteRange.padEnd(BYTE_RANGE_PLACEHOLDER.length, ' '), byteRangePos, 'latin1');

    const signedContent = Buffer.concat([out.subarray(0, contentsStart), out.subarray(contentsEnd)]);
    const cmsHex = this.createCmsSignature(signedContent, options.credentials, signingTime);
    if (cmsHex.length > contentsHex.length) {
      throw new InternalServerErrorException('Chữ ký số vượt quá dung lượng dành sẵn trong file PDF');
    }
    out.write(cmsHex, contentsStart + 1, 'latin1');

    this.logger.log(
      `Đã ký số PDF (${pdf.length} → ${out.length} byte, ${prev.isStream ? 'xref stream' : 'xref table'}, ${appearance ? 'hiển thị' : 'ẩn'})`,
    );
    return out;
  }

  /** CMS SignedData detached (RFC 5652): signed attributes contentType + messageDigest + signingTime */
  private createCmsSignature(content: Buffer, credentials: SignerCredentials, signingTime: Date): string {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(content.toString('binary'));
    p7.addCertificate(credentials.certificate);
    for (const cert of credentials.chain) p7.addCertificate(cert);
    p7.addSigner({
      key: credentials.privateKey,
      certificate: credentials.certificate,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        // forge chấp nhận Date cho signingTime dù typings khai báo string
        { type: forge.pki.oids.signingTime, value: signingTime as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    const asn1 = p7.toAsn1();
    this.useOriginalIssuerDer(asn1, credentials.certificate);
    const der = forge.asn1.toDer(asn1).getBytes();
    return Buffer.from(der, 'binary').toString('hex').toUpperCase();
  }

  /**
   * node-forge dựng lại issuer trong SignerInfo.issuerAndSerialNumber từ các field đã parse, và
   * encode UTF-8 LẦN NỮA với field UTF8String (DN tiếng Việt có dấu) → issuer không còn khớp
   * chứng thư, Acrobat/poppler/OpenSSL báo "signer certificate not found". Thay bằng đúng ASN.1
   * issuer gốc trong TBSCertificate của chứng thư. issuerAndSerialNumber không thuộc phần dữ liệu
   * được ký (signed attributes) nên thay sau khi ký không ảnh hưởng chữ ký.
   */
  private useOriginalIssuerDer(contentInfo: forge.asn1.Asn1, cert: forge.pki.Certificate): void {
    const tbs = (cert as unknown as { tbsCertificate?: forge.asn1.Asn1 }).tbsCertificate;
    const tbsFields = tbs?.value as forge.asn1.Asn1[] | undefined;
    if (!tbsFields) return;
    // TBSCertificate: [0] version (tuỳ chọn) | serialNumber | signature | issuer | …
    const hasVersion = tbsFields[0]?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC;
    const issuer = tbsFields[hasVersion ? 3 : 2];

    const signedData = ((contentInfo.value as forge.asn1.Asn1[])[1]?.value as forge.asn1.Asn1[])?.[0];
    const sdFields = signedData?.value as forge.asn1.Asn1[] | undefined;
    const signerInfos = sdFields?.[sdFields.length - 1]?.value as forge.asn1.Asn1[] | undefined;
    const issuerAndSerial = (signerInfos?.[0]?.value as forge.asn1.Asn1[] | undefined)?.[1];
    if (!issuer || !issuerAndSerial || !Array.isArray(issuerAndSerial.value)) {
      this.logger.warn('Không định vị được issuerAndSerialNumber trong CMS — giữ nguyên bản node-forge dựng');
      return;
    }
    issuerAndSerial.value[0] = issuer;
  }

  /** Đọc startxref cuối file + /Size + loại xref (bảng truyền thống hay xref stream) của revision trước */
  private readPreviousXref(pdf: Buffer): { offset: number; size: number; isStream: boolean } {
    const tailStart = Math.max(0, pdf.length - 4096);
    const tail = pdf.subarray(tailStart).toString('latin1');
    const idx = tail.lastIndexOf('startxref');
    const m = idx === -1 ? null : /startxref\s+(\d+)/.exec(tail.slice(idx));
    if (!m) throw new BadRequestException('Cấu trúc file PDF không hợp lệ (thiếu startxref)');
    const offset = Number(m[1]);
    if (!Number.isFinite(offset) || offset >= pdf.length) {
      throw new BadRequestException('Cấu trúc file PDF không hợp lệ (startxref sai)');
    }

    const head = pdf.subarray(offset, Math.min(pdf.length, offset + 4096)).toString('latin1');
    const trimmed = head.replace(/^\s+/, '');
    let isStream: boolean;
    let sizeWindow: string;
    if (trimmed.startsWith('xref')) {
      isStream = false;
      const trailerIdx = pdf.indexOf('trailer', offset, 'latin1');
      sizeWindow = trailerIdx === -1 ? '' : pdf.subarray(trailerIdx, trailerIdx + 2048).toString('latin1');
    } else if (/^\d+\s+\d+\s+obj/.test(trimmed)) {
      isStream = true;
      sizeWindow = trimmed;
    } else {
      throw new BadRequestException('Cấu trúc file PDF không hợp lệ (xref không đọc được)');
    }
    const sizeMatch = /\/Size\s+(\d+)/.exec(sizeWindow);
    return { offset, size: sizeMatch ? Number(sizeMatch[1]) : 0, isStream };
  }

  /**
   * Xref của revision mới — cùng loại với revision trước: file gốc dùng xref stream (PDF 1.5+,
   * VD file xuất từ Word/Acrobat) thì revision mới cũng là xref stream, ngược lại là bảng xref.
   */
  private buildXrefSection(
    ctx: PDFDocument['context'],
    prev: { offset: number; size: number; isStream: boolean },
    entries: XrefEntry[],
    xrefOffset: number,
    catalogRef: PDFRef,
  ): Buffer {
    const info = ctx.trailerInfo.Info instanceof PDFRef ? ` /Info ${ctx.trailerInfo.Info.toString()}` : '';
    const prevId = ctx.trailerInfo.ID instanceof PDFArray ? ctx.trailerInfo.ID : undefined;
    const firstId = prevId?.get(0)?.toString() ?? `<${crypto.randomBytes(16).toString('hex').toUpperCase()}>`;
    const newId = `<${crypto.randomBytes(16).toString('hex').toUpperCase()}>`;
    const id = ` /ID [${firstId} ${newId}]`;

    const all = [...entries];
    let xrefStreamNum: number | undefined;
    if (prev.isStream) {
      xrefStreamNum = Math.max(prev.size, ...all.map((e) => e.num + 1));
      all.push({ num: xrefStreamNum, gen: 0, offset: xrefOffset });
    }
    all.sort((a, b) => a.num - b.num);
    const size = Math.max(prev.size, ...all.map((e) => e.num + 1));

    // Gom các số hiệu liên tiếp thành subsection
    const runs: XrefEntry[][] = [];
    for (const e of all) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1].num + 1 === e.num) last.push(e);
      else runs.push([e]);
    }

    if (!prev.isStream) {
      let s = 'xref\n';
      for (const run of runs) {
        s += `${run[0].num} ${run.length}\n`;
        for (const e of run) {
          s += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
        }
      }
      s += `trailer\n<< /Size ${size} /Root ${catalogRef.toString()}${info}${id} /Prev ${prev.offset} >>\n`;
      s += `startxref\n${xrefOffset}\n%%EOF\n`;
      return Buffer.from(s, 'latin1');
    }

    // Xref stream: W [1 4 2] — type(1) | offset(4) | generation(2), không nén
    const rows = Buffer.alloc(all.length * 7);
    all.forEach((e, i) => {
      rows.writeUInt8(1, i * 7);
      rows.writeUInt32BE(e.offset, i * 7 + 1);
      rows.writeUInt16BE(e.gen, i * 7 + 5);
    });
    const index = runs.map((r) => `${r[0].num} ${r.length}`).join(' ');
    const dict =
      `${xrefStreamNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index}]` +
      ` /Root ${catalogRef.toString()}${info}${id} /Prev ${prev.offset} /Length ${rows.length} >>\nstream\n`;
    return Buffer.concat([
      Buffer.from(dict, 'latin1'),
      rows,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'),
    ]);
  }

  /** Khung chữ ký kiểu "con dấu số": viền + các dòng thông tin người ký, tự co cỡ chữ cho vừa khung */
  private buildAppearanceStream(
    doc: PDFDocument,
    rect: [number, number, number, number],
    lines: { text: string; font: PDFFont; name: string }[],
    fontRefs: Record<string, PDFRef>,
  ) {
    const width = Math.max(1, rect[2] - rect[0]);
    const height = Math.max(1, rect[3] - rect[1]);
    const pad = 4;
    const lineGap = 1.3;
    const baseSize = Math.min(8.5, (height - pad * 2) / (lines.length * lineGap));
    const sized = lines.map((l) => {
      const widthAt1 = l.font.widthOfTextAtSize(l.text, 1);
      const size = Math.max(4, Math.min(baseSize, (width - pad * 2) / Math.max(widthAt1, 0.0001)));
      return { ...l, size };
    });
    const blockHeight = sized.reduce((sum, l) => sum + l.size * lineGap, 0);
    let y = (height + blockHeight) / 2 - sized[0].size;

    const ops: PDFOperator[] = [
      pushGraphicsState(),
      setStrokingRgbColor(0.78, 0.07, 0.07),
      setLineWidth(0.8),
      rectangle(0.5, 0.5, width - 1, height - 1),
      stroke(),
      setFillingRgbColor(0.78, 0.07, 0.07),
    ];
    for (const l of sized) {
      ops.push(
        beginText(),
        setFontAndSize(l.name, l.size),
        moveText(pad, y),
        showText(l.font.encodeText(l.text)),
        endText(),
      );
      y -= l.size * lineGap;
    }
    ops.push(popGraphicsState());

    const ctx = doc.context;
    const fontDict = ctx.obj(Object.fromEntries(Object.entries(fontRefs)));
    return ctx.formXObject(ops, {
      BBox: [0, 0, width, height],
      Resources: { Font: fontDict },
    });
  }
}
