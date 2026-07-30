import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Đầu vào thuần (không phụ thuộc Mongoose schema) — giữ document-signing độc lập với module
 * Contract để có thể tái dùng cho EInvoice sau này (xem kế hoạch).
 */
export interface ContractPdfParty {
  name: string;
  address: string;
  representative: string;
  position: string;
  phone: string;
  email: string;
  taxCode: string;
}

export interface ContractPdfItem {
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface ContractPdfPaymentInstallment {
  percent: number;
  timing: string;
}

export interface ContractPdfInput {
  contractNo: string;
  items: ContractPdfItem[];
  totalAmount: number;
  partyA: ContractPdfParty;
  partyB: ContractPdfParty;
  signPlace: string;
  signDate?: Date;
  technicalRequirements: string;
  paymentSchedule: ContractPdfPaymentInstallment[];
  bankAccountNumber: string;
  bankName: string;
  bankAccountHolder: string;
  deliveryDate?: Date;
}

// ── Đọc số tiền thành chữ (port từ frontend ContractDocument.tsx) ────────────

const VN_DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function readTriple(n: number, showZeroHundred: boolean): string {
  const hundred = Math.floor(n / 100);
  const ten = Math.floor((n % 100) / 10);
  const unit = n % 10;
  const parts: string[] = [];
  if (hundred > 0 || showZeroHundred) parts.push(VN_DIGITS[hundred], 'trăm');
  if (ten > 1) {
    parts.push(VN_DIGITS[ten], 'mươi');
    if (unit === 1) parts.push('mốt');
    else if (unit === 4) parts.push('tư');
    else if (unit === 5) parts.push('lăm');
    else if (unit > 0) parts.push(VN_DIGITS[unit]);
  } else if (ten === 1) {
    parts.push('mười');
    if (unit === 5) parts.push('lăm');
    else if (unit > 0) parts.push(VN_DIGITS[unit]);
  } else if (unit > 0) {
    if (hundred > 0 || showZeroHundred) parts.push('lẻ');
    parts.push(VN_DIGITS[unit]);
  }
  return parts.join(' ');
}

function numberToVietnameseWords(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  let n = Math.floor(Math.abs(amount));
  if (n === 0) return 'Không đồng';
  const scales = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ', ' triệu tỷ'];
  const triples: number[] = [];
  while (n > 0) {
    triples.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const parts: string[] = [];
  for (let i = triples.length - 1; i >= 0; i--) {
    if (triples[i] === 0) continue;
    parts.push(readTriple(triples[i], i !== triples.length - 1) + scales[i]);
  }
  const sentence = parts.join(' ').replace(/\s+/g, ' ').trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ' đồng';
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

function formatNumber(amount: number): string {
  return amount.toLocaleString('vi-VN');
}

const DOTS = '………………………………';

function dots(value?: string | number | null, fallback = DOTS): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function vnDate(value?: Date | null): string {
  if (!value) return 'ngày ………… tháng ………… năm …………';
  return `ngày ${String(value.getDate()).padStart(2, '0')} tháng ${String(value.getMonth() + 1).padStart(2, '0')} năm ${value.getFullYear()}`;
}

// ── Styling ───────────────────────────────────────────────────────────────

const p = (text: Content, opts: Record<string, unknown> = {}): Content => ({
  text,
  margin: [0, 3, 0, 3],
  alignment: 'justify',
  ...opts,
});

const indent = (text: Content): Content => ({
  text,
  margin: [18, 1, 0, 1],
  alignment: 'justify',
});

const articleTitle = (text: string): Content => ({
  text,
  bold: true,
  margin: [0, 10, 0, 3],
});

function partyBlock(title: string, party: ContractPdfParty, isCompany?: boolean): Content[] {
  return [
    { text: title, bold: true, margin: [0, 6, 0, 2] },
    indent(`${isCompany ? 'Tên đơn vị' : 'Tên tổ chức / cá nhân'}: ${dots(party?.name)}`),
    indent(`Địa chỉ: ${dots(party?.address)}`),
    indent(
      `Đại diện: ${dots(party?.representative, '……………………')}    Chức vụ: ${dots(party?.position, '……………………')}`,
    ),
    indent(
      `Điện thoại: ${dots(party?.phone, '……………………')}    Email: ${dots(party?.email, '……………………')}`,
    ),
    indent(`${isCompany ? 'Mã số thuế' : 'Mã số thuế / CCCD'}: ${dots(party?.taxCode, '……………………')}`),
  ];
}

/** Xây dựng docDefinition cho pdfmake — mirror nội dung frontend ContractDocument.tsx (15 Điều). */
export function buildContractDocDefinition(data: ContractPdfInput): TDocumentDefinitions {
  const d = data.signDate ?? null;

  const itemRows: TableCell[][] = data.items.map((item, i) => [
    { text: String(i + 1), alignment: 'center' },
    { text: item.productCode, alignment: 'center' },
    { text: item.productName },
    { text: String(item.quantity), alignment: 'center' },
    { text: formatNumber(item.unitPrice), alignment: 'right' },
    { text: formatNumber(item.subtotal), alignment: 'right' },
  ]);

  const paymentLines: Content[] = (data.paymentSchedule ?? []).map((installment, i) => {
    const isLast = i === (data.paymentSchedule?.length ?? 0) - 1;
    const amount = Math.round((data.totalAmount * installment.percent) / 100);
    return indent(
      `– Đợt ${i + 1}: Bên A thanh toán ${installment.percent}% giá trị hợp đồng (${formatCurrency(amount)}) ${dots(
        installment.timing,
        '……………',
      )}${isLast ? '.' : ';'}`,
    );
  });

  const content: Content[] = [
    { text: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', alignment: 'center', bold: true },
    { text: 'Độc lập – Tự do – Hạnh phúc', alignment: 'center', bold: true, decoration: 'underline', margin: [0, 2, 0, 10] },

    { text: 'HỢP ĐỒNG THIẾT KẾ VÀ SẢN XUẤT SẢN PHẨM IN 3D', alignment: 'center', bold: true, fontSize: 14, margin: [0, 0, 0, 2] },
    { text: `Số: ${dots(data.contractNo, '…………/HĐ-…………')}`, alignment: 'center', margin: [0, 0, 0, 10] },

    { text: '– Căn cứ Bộ luật Dân sự số 91/2015/QH13;', italics: true, margin: [0, 2, 0, 2] },
    { text: '– Căn cứ Luật Thương mại số 36/2005/QH11;', italics: true, margin: [0, 2, 0, 2] },
    { text: '– Căn cứ nhu cầu và khả năng của hai bên.', italics: true, margin: [0, 2, 0, 2] },

    p(
      `Hôm nay, ${vnDate(d)}, tại ${dots(data.signPlace)}, chúng tôi gồm:`,
    ),

    ...partyBlock('BÊN A (BÊN ĐẶT HÀNG):', data.partyA),
    ...partyBlock('BÊN B (BÊN THIẾT KẾ VÀ SẢN XUẤT):', data.partyB, true),

    p('Sau khi bàn bạc, hai bên thống nhất ký kết hợp đồng với các điều khoản sau:'),

    articleTitle('Điều 1. Nội dung hợp đồng'),
    p('1.1. Bên A giao và Bên B nhận thực hiện việc thiết kế và sản xuất (in 3D) sản phẩm theo yêu cầu của Bên A, chi tiết như sau:'),
    {
      table: {
        headerRows: 1,
        widths: [24, 55, '*', 40, 65, 70],
        body: [
          [
            { text: 'STT', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
            { text: 'Mã SP', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
            { text: 'Tên sản phẩm', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
            { text: 'SL', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
            { text: 'Đơn giá (VNĐ)', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
            { text: 'Thành tiền (VNĐ)', bold: true, alignment: 'center', fillColor: '#f5f5f5' },
          ] as TableCell[],
          ...itemRows,
          [
            { text: 'Tổng cộng', colSpan: 5, alignment: 'center', bold: true },
            {},
            {},
            {},
            {},
            { text: formatNumber(data.totalAmount), alignment: 'right', bold: true },
          ] as TableCell[],
        ],
      },
      layout: 'lightHorizontalLines',
      fontSize: 9.5,
      margin: [0, 4, 0, 4],
    },
    p(`1.2. Yêu cầu kỹ thuật khác (công nghệ in FDM/SLA/SLS, độ dày lớp in, xử lý bề mặt, độ đặc…): ${dots(data.technicalRequirements, 'KHÔNG')}`),

    articleTitle('Điều 2. Thiết kế và duyệt mẫu'),
    p('2.1. Bên B thiết kế file 3D dựa trên yêu cầu, bản vẽ, hình ảnh hoặc mẫu vật do Bên A cung cấp.'),
    p('2.2. Bên A được yêu cầu chỉnh sửa thiết kế tối đa 05 lần miễn phí; từ lần tiếp theo tính phí 50.000 VNĐ/lần.'),
    p('2.3. Bên B chỉ tiến hành sản xuất sau khi Bên A xác nhận duyệt thiết kế (qua email, tin nhắn hoặc văn bản). Bản thiết kế đã duyệt là căn cứ để nghiệm thu sản phẩm.'),
    p('2.4. Yêu cầu thay đổi thiết kế sau khi đã duyệt được coi là yêu cầu mới; hai bên thỏa thuận lại chi phí và thời gian thực hiện.'),

    articleTitle('Điều 3. Giá trị hợp đồng và thanh toán'),
    p([
      '3.1. Tổng giá trị hợp đồng: ',
      { text: formatCurrency(data.totalAmount), bold: true },
      ' (bằng chữ: ',
      { text: numberToVietnameseWords(data.totalAmount), italics: true },
      '). Giá trên đã bao gồm thuế GTGT và chi phí vận chuyển.',
    ] as unknown as Content),
    p('3.2. Thanh toán chia thành 03 đợt:'),
    ...paymentLines,
    p(
      `3.3. Hình thức thanh toán: tiền mặt hoặc chuyển khoản. Số tài khoản: ${dots(data.bankAccountNumber, '……………………')} Ngân hàng: ${dots(data.bankName, '……………………')} Chủ tài khoản: ${dots(data.bankAccountHolder, '……………………')}`,
    ),

    articleTitle('Điều 4. Thời gian thực hiện và giao nhận'),
    p(`4.1. Thời gian giao hàng: ${vnDate(data.deliveryDate ?? null)}.`),
    p('4.2. Địa điểm giao hàng theo thoả thuận giữa hai bên. Chi phí vận chuyển do Bên B chịu (đã bao gồm trong giá trị hợp đồng).'),
    p('4.3. Bên A kiểm tra và nghiệm thu số lượng, ngoại quan sản phẩm khi Bên B bàn giao; khiếu nại (nếu có) gửi cho Bên B trong vòng 05 ngày làm việc kể từ ngày nghiệm thu.'),

    articleTitle('Điều 5. Tiêu chuẩn chất lượng và sai số'),
    p('5.1. Sản phẩm được xem là đạt yêu cầu khi:'),
    indent('– Đúng mẫu thiết kế hoặc mẫu đối chứng đã được duyệt;'),
    indent('– Đúng vật liệu, màu sắc và số lượng đã thống nhất;'),
    indent('– Không bị gãy, nứt hoặc thiếu chi tiết làm mất công năng;'),
    indent('– Các bộ phận lắp ráp hoạt động theo yêu cầu đã thống nhất;'),
    indent('– Bề mặt được làm sạch cơ bản;'),
    indent('– Phụ kiện được lắp hoặc đóng kèm đầy đủ;'),
    indent('– Được đóng gói theo thỏa thuận.'),
    p('5.2. Sai số kích thước cho phép:'),
    indent('– Kích thước dưới 50 mm: ±0,1 mm;'),
    indent('– Kích thước từ 50 mm đến dưới 150 mm: ±1 mm;'),
    indent('– Kích thước từ 150 mm trở lên: ±10 mm;'),
    indent('– Sai số lắp ghép hoặc chi tiết kỹ thuật: theo bản vẽ hoặc mẫu thử đã được duyệt.'),
    p('5.3. Đối với sản phẩm yêu cầu độ chính xác cao, hai bên phải ghi rõ dung sai riêng bằng văn bản trước khi sản xuất.'),

    articleTitle('Điều 6. Quyền và nghĩa vụ của các bên'),
    p('6.1. Bên A: cung cấp đầy đủ, chính xác yêu cầu và tài liệu liên quan; duyệt thiết kế đúng thời hạn; thanh toán và nghiệm thu sản phẩm theo đúng thỏa thuận.'),
    p('6.2. Bên B: thiết kế và sản xuất đúng mẫu đã duyệt, đúng tiến độ; bảo mật thông tin, tài liệu và file thiết kế của Bên A; thông báo kịp thời cho Bên A các vấn đề phát sinh trong quá trình thực hiện.'),

    articleTitle('Điều 7. Chậm thanh toán'),
    p('Nếu Bên A chậm thanh toán, Bên B có quyền:'),
    indent('– Tạm ngừng thiết kế, sản xuất hoặc giao hàng;'),
    indent('– Điều chỉnh lại thời hạn hoàn thành tương ứng;'),
    indent('– Yêu cầu bồi thường các thiệt hại thực tế phát sinh.'),

    articleTitle('Điều 8. Xử lý sản phẩm không đạt'),
    p('8.1. Đối với sản phẩm được xác định là lỗi do Bên B, Bên B sẽ lựa chọn một hoặc nhiều phương án: sửa chữa; sản xuất bù; đổi sản phẩm; hoàn lại giá trị tương ứng của sản phẩm lỗi; hoặc giảm giá theo thỏa thuận.'),
    p('8.2. Bên B không chịu trách nhiệm đối với lỗi phát sinh do:'),
    indent('– Bên A sử dụng sai mục đích;'),
    indent('– Bảo quản không đúng hướng dẫn;'),
    indent('– Để sản phẩm tiếp xúc với nhiệt độ, tải trọng hoặc hóa chất vượt mức đã thống nhất;'),
    indent('– Tự ý sửa chữa, khoan, cắt, nung, sơn hoặc thay đổi kết cấu;'),
    indent('– Hao mòn tự nhiên;'),
    indent('– Hư hỏng trong quá trình vận chuyển thuộc trách nhiệm của đơn vị vận chuyển;'),
    indent('– Thiết kế, kích thước hoặc tài liệu kỹ thuật do Bên A cung cấp có sai sót.'),

    articleTitle('Điều 9. Sở hữu trí tuệ'),
    p('9.1. File thiết kế 3D thuộc quyền sở hữu của Bên A; Bên A được lưu file vĩnh viễn.'),
    p('9.2. Bên B không được sử dụng file thiết kế này để sản xuất, mua bán dưới bất kỳ hình thức nào nếu chưa được Bên A chấp thuận.'),
    p('9.3. Bên A cam kết nội dung đặt hàng không vi phạm quyền sở hữu trí tuệ của bên thứ ba và tự chịu trách nhiệm nếu phát sinh tranh chấp liên quan.'),

    articleTitle('Điều 10. Giới hạn mục đích sử dụng'),
    p('10.1. Trừ khi được hai bên thỏa thuận rõ bằng văn bản, sản phẩm không mặc nhiên được chứng nhận để sử dụng cho:'),
    indent('– Thiết bị y tế;'),
    indent('– Chi tiết an toàn của phương tiện giao thông;'),
    indent('– Chi tiết chịu tải trọng lớn;'),
    indent('– Thiết bị điện hoặc phòng cháy chữa cháy;'),
    indent('– Sản phẩm tiếp xúc trực tiếp với thực phẩm;'),
    indent('– Đồ chơi dành cho trẻ nhỏ;'),
    indent('– Vật dụng chịu nhiệt độ cao;'),
    indent('– Thiết bị bảo hộ;'),
    indent('– Các ứng dụng khác có thể gây nguy hiểm đến sức khỏe hoặc tính mạng.'),
    p('10.2. Bên A phải thông báo trước cho Bên B nếu sản phẩm được sử dụng cho một trong các mục đích trên.'),
    p('10.3. Bên B chỉ chịu trách nhiệm về khả năng sử dụng đặc biệt khi nội dung đó được ghi nhận rõ bằng văn bản và sản phẩm đã được kiểm tra theo tiêu chuẩn tương ứng.'),

    articleTitle('Điều 11. Bảo hành'),
    p('11.1. Thời hạn bảo hành: 30 (ba mươi) ngày kể từ ngày nghiệm thu.'),
    p('11.2. Phạm vi bảo hành áp dụng đối với:'),
    indent('– Lỗi gãy, nứt hoặc tách lớp do quá trình sản xuất;'),
    indent('– Lỗi lắp ráp do Bên B thực hiện;'),
    indent('– Thiếu hoặc sai phụ kiện;'),
    indent('– Sản phẩm không thực hiện được công năng đã thống nhất do lỗi sản xuất.'),
    p('11.3. Không thuộc phạm vi bảo hành:'),
    indent('– Trầy xước hoặc hao mòn trong quá trình sử dụng;'),
    indent('– Sản phẩm bị biến dạng do nhiệt;'),
    indent('– Sản phẩm bị rơi, va đập, chịu tải quá mức;'),
    indent('– Sản phẩm bị ngâm nước hoặc tiếp xúc hóa chất khi không được thiết kế cho mục đích đó;'),
    indent('– Hư hỏng do sử dụng sai hướng dẫn;'),
    indent('– Chênh lệch nhỏ về màu sắc, đường lớp in hoặc dấu support nằm trong giới hạn chấp nhận;'),
    indent('– Sản phẩm mẫu, hàng thanh lý hoặc hàng được thông báo không bảo hành.'),

    articleTitle('Điều 12. Sự kiện bất khả kháng'),
    p('12.1. Sự kiện bất khả kháng là sự kiện xảy ra khách quan, không thể dự đoán hợp lý và không thể khắc phục dù bên bị ảnh hưởng đã áp dụng các biện pháp cần thiết, bao gồm nhưng không giới hạn: thiên tai; hỏa hoạn; dịch bệnh; chiến tranh; bạo loạn; mất điện diện rộng kéo dài; hạn chế vận chuyển; quyết định của cơ quan nhà nước; sự cố hạ tầng nghiêm trọng ngoài khả năng kiểm soát.'),
    p('12.2. Bên bị ảnh hưởng phải: (a) thông báo cho bên còn lại trong thời gian sớm nhất; (b) cung cấp thông tin về mức độ ảnh hưởng; (c) áp dụng biện pháp hợp lý để hạn chế thiệt hại; (d) tiếp tục thực hiện nghĩa vụ ngay khi sự kiện chấm dứt.'),
    p('12.3. Thời hạn thực hiện hợp đồng được gia hạn tương ứng với thời gian bị ảnh hưởng. Nếu sự kiện kéo dài quá 05 ngày làm việc, hai bên sẽ thỏa thuận tiếp tục, điều chỉnh hoặc chấm dứt hợp đồng.'),

    articleTitle('Điều 13. Thông báo và xác nhận điện tử'),
    p('13.1. Các thông báo, xác nhận thiết kế, duyệt mẫu, báo giá phát sinh và thỏa thuận thực hiện qua các phương tiện sau được xem là bằng chứng giao dịch giữa hai bên: email; Zalo; Messenger; nền tảng quản lý công việc; chữ ký điện tử; tài liệu điện tử; hoặc phương tiện khác được hai bên thống nhất.'),
    p('13.2. Thông tin liên hệ chính thức:'),
    indent(`– Bên A: ${dots([data.partyA?.phone, data.partyA?.email].filter(Boolean).join(' – '))}`),
    indent(`– Bên B: ${dots([data.partyB?.phone, data.partyB?.email].filter(Boolean).join(' – '))}`),
    p('13.3. Mỗi bên phải thông báo bằng văn bản cho bên còn lại khi thay đổi thông tin liên hệ.'),

    articleTitle('Điều 14. Hủy hợp đồng và giải quyết tranh chấp'),
    p('14.1. Nếu Bên A hủy đơn hàng sau khi đã duyệt thiết kế hoặc sản phẩm đã được sản xuất, Bên A không được hoàn lại tiền tạm ứng và phải thanh toán giá trị phần công việc Bên B đã thực hiện.'),
    p('14.2. Trường hợp Bên A chậm thanh toán đợt 3 quá 05 ngày làm việc, Bên A chịu phạt 200% giá trị hợp đồng cho mỗi 05 ngày làm việc chậm, trừ trường hợp bất khả kháng.'),
    p('14.3. Mọi tranh chấp phát sinh được hai bên ưu tiên giải quyết bằng thương lượng, hòa giải; nếu không thành, tranh chấp được đưa ra Tòa án có thẩm quyền giải quyết theo quy định của pháp luật.'),

    articleTitle('Điều 15. Điều khoản chung'),
    p('15.1. Hợp đồng có hiệu lực kể từ ngày ký. Mọi sửa đổi, bổ sung phải được lập thành văn bản hoặc phụ lục có xác nhận của cả hai bên.'),
    p('15.2. Hợp đồng được lập thành 02 (hai) bản có giá trị pháp lý như nhau, mỗi bên giữ 01 (một) bản.'),

    {
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
    },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [45, 40, 45, 40],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25 },
    content,
    info: {
      title: `Hop dong ${data.contractNo}`,
      author: 'Luxe Glow',
    },
  };
}
