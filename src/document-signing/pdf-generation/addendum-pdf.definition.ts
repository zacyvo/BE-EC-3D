import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  ContractPdfItem,
  ContractPdfParty,
  ContractPdfPaymentInstallment,
  dots,
  formatNumber,
  numberToVietnameseWords,
} from './contract-pdf.definition';

/**
 * Phụ lục hợp đồng (sửa đổi, bổ sung sau khi hợp đồng đã chốt) — dùng chung cho mọi mẫu hợp
 * đồng và hợp đồng import. Văn bản chỉ dựng từ PDF này (admin/khách xem PDF, không có bản HTML
 * riêng) nên không phải đồng bộ nội dung ở frontend.
 */
export interface AddendumPdfInput {
  addendumNo: number;
  title?: string;
  content?: string;
  contractNo: string;
  /** Tên loại hợp đồng in sau "Căn cứ", VD: "Hợp đồng thiết kế và sản xuất sản phẩm in 3D" */
  contractName: string;
  contractSignDate?: Date;
  partyA: ContractPdfParty;
  partyB: ContractPdfParty;
  signPlace: string;
  signDate?: Date;
  items: ContractPdfItem[];
  /** Giá trị phụ lục này */
  amount: number;
  /** Giá trị hợp đồng gốc */
  contractAmount: number;
  /** Các phụ lục khác đã chốt (tính vào tổng giá trị sau điều chỉnh) */
  previousAddenda: { addendumNo: number; amount: number }[];
  paymentSchedule: ContractPdfPaymentInstallment[];
  bankAccountNumber: string;
  bankName: string;
  bankAccountHolder: string;
  deliveryDate?: Date;
  /** Bản xem trước (chưa chốt) — in chữ chìm */
  watermark?: string;
}

export function addendumLabel(no: number): string {
  return `Phụ lục số ${String(no).padStart(2, '0')}`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

function vnDate(value?: Date | null): string {
  if (!value) return 'ngày ………… tháng ………… năm …………';
  return `ngày ${String(value.getDate()).padStart(2, '0')} tháng ${String(value.getMonth() + 1).padStart(2, '0')} năm ${value.getFullYear()}`;
}

function dmy(value?: Date | null): string {
  if (!value) return '……/……/…………';
  return `${String(value.getDate()).padStart(2, '0')}/${String(value.getMonth() + 1).padStart(2, '0')}/${value.getFullYear()}`;
}

const p = (text: Content, opts: Record<string, unknown> = {}): Content => ({
  text,
  margin: [0, 3, 0, 3],
  alignment: 'justify',
  ...opts,
});

const indent = (text: Content): Content => ({ text, margin: [18, 1, 0, 1], alignment: 'justify' });

const articleTitle = (text: string): Content => ({ text, bold: true, margin: [0, 10, 0, 3] });

function partyBlock(title: string, party: ContractPdfParty): Content[] {
  return [
    { text: title, bold: true, margin: [0, 6, 0, 2] },
    indent(`Tên: ${dots(party?.name)}`),
    indent(`Địa chỉ: ${dots(party?.address)}`),
    indent(
      `Đại diện: ${dots(party?.representative, '……………………')}    Chức vụ: ${dots(party?.position, '……………………')}`,
    ),
    indent(`Điện thoại: ${dots(party?.phone, '……………………')}    Email: ${dots(party?.email, '……………………')}`),
    indent(`Mã số thuế / CCCD: ${dots(party?.taxCode, '……………………')}`),
  ];
}

const headerCell = (text: string): TableCell => ({ text, bold: true, alignment: 'center', fillColor: '#f5f5f5' });

export function buildAddendumDocDefinition(data: AddendumPdfInput): TDocumentDefinitions {
  const label = addendumLabel(data.addendumNo);
  const previousTotal = data.contractAmount + data.previousAddenda.reduce((s, a) => s + a.amount, 0);
  const newTotal = previousTotal + data.amount;
  const hasItems = data.items.length > 0;
  const content_ = data.content?.trim();

  // ── Điều 1 ──
  const article1: Content[] = [articleTitle('Điều 1. Nội dung sửa đổi, bổ sung')];
  let clause1 = 1;
  if (hasItems) {
    article1.push(
      p(`1.${clause1++}. Bên A giao và Bên B nhận thực hiện bổ sung các hạng mục sau, ngoài phạm vi đã thỏa thuận tại Hợp đồng:`),
      {
        table: {
          headerRows: 1,
          widths: [24, 55, '*', 40, 65, 70],
          body: [
            ['STT', 'Mã', 'Hạng mục / sản phẩm', 'SL', 'Đơn giá (VNĐ)', 'Thành tiền (VNĐ)'].map(headerCell),
            ...data.items.map((item, i): TableCell[] => [
              { text: String(i + 1), alignment: 'center' },
              { text: item.productCode || '—', alignment: 'center' },
              { text: item.productName },
              { text: String(item.quantity), alignment: 'center' },
              { text: formatNumber(item.unitPrice), alignment: 'right' },
              { text: formatNumber(item.subtotal), alignment: 'right' },
            ]),
            [
              { text: `Tổng giá trị ${label}`, colSpan: 5, alignment: 'center', bold: true },
              {},
              {},
              {},
              {},
              { text: formatNumber(data.amount), alignment: 'right', bold: true },
            ] as TableCell[],
          ],
        },
        layout: 'lightHorizontalLines',
        fontSize: 9.5,
        margin: [0, 4, 0, 4],
      },
    );
  }
  if (content_) {
    article1.push(p(`1.${clause1++}. ${hasItems ? 'Nội dung sửa đổi, bổ sung khác' : 'Hai bên thống nhất sửa đổi, bổ sung Hợp đồng như sau'}:`));
    for (const line of content_.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      article1.push(indent(line));
    }
  }
  if (hasItems) {
    article1.push(
      p(
        `1.${clause1}. Các hạng mục bổ sung áp dụng cùng tiêu chuẩn chất lượng, quy trình duyệt mẫu, nghiệm thu và bảo hành như quy định tại Hợp đồng, trừ khi Phụ lục này có thỏa thuận khác.`,
      ),
    );
  }

  // ── Điều 2 ──
  const totalRows: TableCell[][] = [
    [{ text: 'Giá trị Hợp đồng ban đầu' }, { text: formatNumber(data.contractAmount), alignment: 'right' }],
    ...data.previousAddenda.map((a): TableCell[] => [
      { text: `${addendumLabel(a.addendumNo)} (đã lập trước)` },
      { text: formatNumber(a.amount), alignment: 'right' },
    ]),
    [{ text: `${label} (Phụ lục này)` }, { text: formatNumber(data.amount), alignment: 'right' }],
    [
      { text: 'Tổng giá trị Hợp đồng sau điều chỉnh', bold: true },
      { text: formatNumber(newTotal), alignment: 'right', bold: true },
    ],
  ];
  const article2: Content[] = [
    articleTitle('Điều 2. Giá trị Phụ lục và tổng giá trị Hợp đồng'),
    data.amount > 0
      ? p([
          `2.1. Giá trị ${label}: `,
          { text: formatCurrency(data.amount), bold: true },
          ' (bằng chữ: ',
          { text: numberToVietnameseWords(data.amount), italics: true },
          '). Điều kiện về thuế và chi phí vận chuyển áp dụng như quy định tại Hợp đồng.',
        ] as unknown as Content)
      : p(`2.1. ${label} không làm phát sinh thêm giá trị thanh toán.`),
    p([
      '2.2. Tổng giá trị Hợp đồng sau khi điều chỉnh theo Phụ lục này: ',
      { text: formatCurrency(newTotal), bold: true },
      ' (bằng chữ: ',
      { text: numberToVietnameseWords(newTotal), italics: true },
      '), chi tiết:',
    ] as unknown as Content),
    {
      table: { widths: ['*', 120], body: [[headerCell('Khoản mục'), headerCell('Giá trị (VNĐ)')], ...totalRows] },
      layout: 'lightHorizontalLines',
      fontSize: 9.5,
      margin: [0, 4, 0, 4],
    },
  ];

  // ── Điều 3 ──
  const schedule = data.amount > 0 ? data.paymentSchedule ?? [] : [];
  const article3: Content[] = [articleTitle('Điều 3. Thanh toán giá trị Phụ lục')];
  if (schedule.length === 0) {
    article3.push(p('3.1. Phụ lục này không làm thay đổi nghĩa vụ thanh toán của Bên A theo Hợp đồng.'));
  } else {
    article3.push(
      p(
        schedule.length === 1
          ? `3.1. Bên A thanh toán giá trị ${label} như sau:`
          : `3.1. Giá trị ${label} được thanh toán thành ${String(schedule.length).padStart(2, '0')} lần:`,
      ),
    );
    schedule.forEach((installment, i) => {
      const amount = Math.round((data.amount * installment.percent) / 100);
      article3.push(
        indent([
          schedule.length === 1 ? '– ' : { text: `– Lần ${i + 1}: `, bold: true },
          `Bên A thanh toán ${installment.percent}% giá trị Phụ lục, tương đương ${formatCurrency(amount)} (bằng chữ: `,
          { text: numberToVietnameseWords(amount), italics: true },
          `) ${dots(installment.timing, '……………')}${i === schedule.length - 1 ? '.' : ';'}`,
        ] as unknown as Content),
      );
    });
    article3.push(
      p(
        `3.2. Hình thức thanh toán: tiền mặt hoặc chuyển khoản. Số tài khoản: ${dots(data.bankAccountNumber, '……………………')} Ngân hàng: ${dots(data.bankName, '……………………')} Chủ tài khoản: ${dots(data.bankAccountHolder, '……………………')}. Nội dung chuyển khoản ghi rõ số Hợp đồng và ${label}.`,
      ),
    );
  }

  // ── Điều 4, 5 ──
  const article4: Content[] = [
    articleTitle('Điều 4. Thời gian và địa điểm giao hàng'),
    p(
      hasItems
        ? data.deliveryDate
          ? `4.1. Thời gian giao các hạng mục bổ sung: ${vnDate(data.deliveryDate)}.`
          : '4.1. Thời gian giao các hạng mục bổ sung: theo tiến độ quy định tại Hợp đồng hoặc theo thỏa thuận bằng văn bản của hai bên.'
        : data.deliveryDate
          ? `4.1. Thời gian giao hàng được điều chỉnh thành: ${vnDate(data.deliveryDate)}.`
          : '4.1. Thời gian giao hàng: giữ nguyên theo Hợp đồng.',
    ),
    p('4.2. Địa điểm giao hàng và chi phí vận chuyển: theo quy định tại Hợp đồng.'),
  ];

  const article5: Content[] = [
    articleTitle('Điều 5. Điều khoản chung'),
    p(`5.1. ${label} là bộ phận không tách rời của Hợp đồng số ${dots(data.contractNo)} và có hiệu lực kể từ ngày hai bên ký.`),
    p('5.2. Các điều khoản khác của Hợp đồng không được sửa đổi, bổ sung tại Phụ lục này giữ nguyên hiệu lực. Trường hợp có mâu thuẫn, nội dung của Phụ lục này được ưu tiên áp dụng đối với phạm vi sửa đổi, bổ sung.'),
    p('5.3. Phụ lục được ký bằng chữ ký số/chữ ký điện tử trên hệ thống có giá trị như bản giấy; trường hợp ký giấy, Phụ lục được lập thành 02 (hai) bản có giá trị pháp lý như nhau, mỗi bên giữ 01 (một) bản.'),
  ];

  const content: Content[] = [
    { text: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', alignment: 'center', bold: true },
    { text: 'Độc lập – Tự do – Hạnh phúc', alignment: 'center', bold: true, decoration: 'underline', margin: [0, 2, 0, 10] },

    { text: `PHỤ LỤC HỢP ĐỒNG SỐ ${String(data.addendumNo).padStart(2, '0')}`, alignment: 'center', bold: true, fontSize: 14, margin: [0, 0, 0, 2] },
    {
      text: `(Kèm theo Hợp đồng số ${dots(data.contractNo)} ký ngày ${dmy(data.contractSignDate)})`,
      alignment: 'center',
      italics: true,
      margin: [0, 0, 0, data.title?.trim() ? 2 : 10],
    },
    ...(data.title?.trim()
      ? [{ text: `V/v: ${data.title.trim()}`, alignment: 'center', bold: true, margin: [0, 0, 0, 10] } as Content]
      : []),

    { text: '– Căn cứ Bộ luật Dân sự số 91/2015/QH13;', italics: true, margin: [0, 2, 0, 2] },
    {
      text: `– Căn cứ ${data.contractName} số ${dots(data.contractNo)} ký ngày ${dmy(data.contractSignDate)} giữa hai bên (sau đây gọi là "Hợp đồng");`,
      italics: true,
      margin: [0, 2, 0, 2],
    },
    { text: '– Căn cứ nhu cầu thực tế và thỏa thuận của hai bên.', italics: true, margin: [0, 2, 0, 2] },

    p(`Hôm nay, ${vnDate(data.signDate ?? null)}, tại ${dots(data.signPlace)}, chúng tôi gồm:`),
    ...partyBlock('BÊN A (BÊN ĐẶT HÀNG):', data.partyA),
    ...partyBlock('BÊN B (BÊN THIẾT KẾ VÀ SẢN XUẤT):', data.partyB),

    p(`Hai bên thống nhất ký ${label} để sửa đổi, bổ sung Hợp đồng với các nội dung sau:`),
    ...article1,
    ...article2,
    ...article3,
    ...article4,
    ...article5,

    {
      // Tiêu đề "ĐẠI DIỆN BÊN A/B" — SignaturePlacementService dựa vào đây để đặt khung chữ ký số
      columns: [
        {
          alignment: 'center',
          text: [
            { text: 'ĐẠI DIỆN BÊN A\n', bold: true },
            { text: '(Ký, ghi rõ họ tên)\n\n\n\n\n', italics: true },
            { text: data.partyA?.representative || data.partyA?.name || '' },
          ],
        },
        {
          alignment: 'center',
          text: [
            { text: 'ĐẠI DIỆN BÊN B\n', bold: true },
            { text: '(Ký, ghi rõ họ tên)\n\n\n\n\n', italics: true },
            { text: data.partyB?.representative || data.partyB?.name || '' },
          ],
        },
      ],
      margin: [0, 20, 0, 0],
      // Giữ trọn khối ký trên 1 trang — tách trang sẽ đẩy họ tên người ký sang trang sau
      unbreakable: true,
    } as Content,
  ];

  return {
    pageSize: 'A4',
    pageMargins: [45, 40, 45, 40],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25 },
    content,
    ...(data.watermark ? { watermark: { text: data.watermark, opacity: 0.08, bold: true } } : {}),
    info: {
      title: `Phu luc ${String(data.addendumNo).padStart(2, '0')} - Hop dong ${data.contractNo}`,
      author: 'Luxe Glow',
    },
  };
}
