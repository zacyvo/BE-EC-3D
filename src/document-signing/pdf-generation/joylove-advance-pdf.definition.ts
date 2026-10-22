import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  ContractPdfInput,
  ContractPdfParty,
  dots,
  formatNumber,
  numberToVietnameseWords,
} from './contract-pdf.definition';

/**
 * Template JOYLOVE_ADVANCE — dựng theo mẫu JOYLOVE_Luxe_Glow_Hop_dong.pdf (15 Điều + Phụ lục 01, 02).
 * Mirror nội dung frontend JoyloveAdvanceDocument.tsx (admin + user) — sửa văn bản phải sửa cả 3 nơi.
 */

const NAVY = '#1f2a44';
const SHORT_DOTS = '……………………';
const DOTS_LONG = '……………………………………';

function dmy(value?: Date | null): string {
  if (!value) return '……/……/…………';
  return `${String(value.getDate()).padStart(2, '0')}/${String(value.getMonth() + 1).padStart(2, '0')}/${value.getFullYear()}`;
}

const p = (text: Content, opts: Record<string, unknown> = {}): Content => ({
  text,
  margin: [0, 2, 0, 4],
  alignment: 'justify',
  ...opts,
});

/** Khoản có số hiệu in đậm, VD: "1.1." */
const clause = (no: string, text: string): Content => p([{ text: `${no} `, bold: true }, text] as unknown as Content);

const sub = (text: string): Content => ({ text, margin: [14, 1, 0, 3], alignment: 'justify' });

const articleTitle = (text: string): Content => ({ text, bold: true, color: NAVY, margin: [0, 9, 0, 3] });

const sectionTitle = (text: string): Content => ({ text, bold: true, color: NAVY, fontSize: 11.5, margin: [0, 8, 0, 4] });

const labelLine = (label: string, value: string): Content =>
  ({ text: [{ text: `${label}: `, bold: true }, value], margin: [0, 1, 0, 1] }) as Content;

const tableLayout: CustomTableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => '#b8c0cc',
  vLineColor: () => '#b8c0cc',
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

const th = (text: string): TableCell => ({ text, bold: true, fillColor: '#e8edf5', color: NAVY });

function signatureColumns(title: string, subtitle: string, names?: [string, string]): Content {
  const col = (side: 'A' | 'B', name?: string): Content => ({
    alignment: 'center',
    stack: [
      { text: `${title} BÊN ${side} – ${side === 'A' ? 'JOYLOVE' : 'LUXE GLOW'}`, bold: true, color: NAVY },
      { text: subtitle, italics: true, margin: [0, 1, 0, 0] },
      ...(names ? [{ text: name ?? '', margin: [0, 50, 0, 0] } as Content] : []),
    ],
  });
  return { columns: [col('A', names?.[0]), col('B', names?.[1])], margin: [0, 14, 0, 0] };
}

function partyAName(party: ContractPdfParty): string {
  return party?.representative || party?.name || '';
}

export function buildJoyloveAdvanceDocDefinition(data: ContractPdfInput): TDocumentDefinitions {
  const A = data.partyA;
  const B = data.partyB;
  const total = formatNumber(data.totalAmount);
  const schedule = data.paymentSchedule ?? [];

  const paymentLines: Content[] = schedule.map((installment, i) => {
    const amount = Math.round((data.totalAmount * installment.percent) / 100);
    const letter = String.fromCharCode(97 + i); // a, b, c…
    let extra = '';
    if (i === 0) {
      extra = ' Bên B bắt đầu triển khai theo Điều 4 sau khi nhận đủ khoản thanh toán này và đủ tài liệu đầu vào cần thiết.';
    } else if (i === schedule.length - 1) {
      extra = ' Đối với nghiệm thu từng phần, khoản phải trả được xác định theo giá trị phần đã nghiệm thu; Bên A không giữ lại thanh toán của phần đạt yêu cầu chỉ vì phần khác còn lỗi.';
    }
    return sub(
      `${letter}) Đợt ${i + 1}: ${installment.percent}% giá trị Hợp đồng, tương đương ${formatNumber(amount)} đồng, ${dots(installment.timing, SHORT_DOTS)}.${extra}`,
    );
  });

  const itemRows: TableCell[][] = data.items.map((item, i) => [
    { text: String(i + 1), alignment: 'center' },
    { text: `${item.productCode} – ${item.productName}` },
    { text: String(item.quantity), alignment: 'center' },
    { text: formatNumber(item.unitPrice), alignment: 'right' },
    { text: formatNumber(item.subtotal), alignment: 'right' },
  ]);

  // Phụ lục 02 — liệt kê sẵn tên hàng, số lượng giao/đạt do hai bên điền khi giao nhận (tối thiểu 3 dòng)
  const handoverRows: TableCell[][] = data.items.map((item) => [
    { text: `${item.productCode} – ${item.productName}` }, '……', '……', '……', '……………………',
  ]);
  while (handoverRows.length < 3) handoverRows.push(['……………………', '……', '……', '……', '……………………']);

  const specRows: [string, string][] = [
    ['Công nghệ in, thiết bị, vật liệu', dots(data.technicalRequirements)],
    ['Màu sắc / hãng filament / mã màu', dots('')],
    ['Kích thước, dung sai, lắp ghép', dots('')],
    ['Yêu cầu ngoại quan, đường lớp, support', dots('')],
    ['Công năng, phụ kiện, logo, tem nhãn, đóng gói', dots('')],
    ['Mã file/mẫu, phiên bản và ngày duyệt', dots('')],
    ['Bàn giao file, kiểm tra, rủi ro vận chuyển', dots('')],
  ];

  const scheduleRows: [string, string][] = [
    ['Bàn giao thông tin thiết kế và nhận cọc đợt 1', dots('')],
    ['Ngày dự kiến duyệt thiết kế/mẫu', dots('')],
    ['Ngày dự kiến hoàn tất sản xuất', dots('')],
    ['Ngày giao hàng và đơn vị vận chuyển', data.deliveryDate ? dmy(data.deliveryDate) : dots('')],
    ['Phí vận chuyển và bên chịu phí', dots('')],
  ];

  const content: Content[] = [
    { text: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', alignment: 'center', bold: true },
    { text: 'Độc lập – Tự do – Hạnh phúc', alignment: 'center', bold: true, decoration: 'underline', margin: [0, 1, 0, 10] },
    { text: 'HỢP ĐỒNG THIẾT KẾ VÀ SẢN XUẤT SẢN PHẨM IN 3D', alignment: 'center', bold: true, fontSize: 14, color: NAVY },
    { text: '(DÀNH CHO DỰ ÁN JOYLOVE)', alignment: 'center', bold: true, color: NAVY, margin: [0, 2, 0, 2] },
    { text: `Số: ${dots(data.contractNo, '…………/HĐ-…………')}`, alignment: 'center', margin: [0, 0, 0, 10] },

    p('Căn cứ Bộ luật Dân sự năm 2015; Luật Thương mại năm 2005; Luật Giao dịch điện tử năm 2023 và các quy định pháp luật hiện hành có liên quan;', { margin: [0, 1, 0, 1] }),
    p('Căn cứ nhu cầu đặt hàng của Bên A và khả năng cung cấp dịch vụ thiết kế, sản xuất in 3D của Bên B;', { margin: [0, 1, 0, 1] }),
    p(`Ngày lập văn bản: ${dmy(data.createdAt ?? null)}. Ngày ký và thời điểm có hiệu lực được xác định theo Điều 15.2 của Hợp đồng.`),

    sectionTitle('BÊN A – BÊN ĐẶT HÀNG (DỰ ÁN JOYLOVE)'),
    labelLine('Tên pháp nhân/hộ kinh doanh/cá nhân ký hợp đồng', dots(A?.name)),
    labelLine('Tên thương mại/nhãn hiệu sử dụng trong đơn hàng', 'JOYLOVE'),
    labelLine('Địa chỉ đăng ký', dots(A?.address)),
    labelLine('Mã số thuế / Số đăng ký / CCCD', dots(A?.taxCode)),
    {
      text: [
        { text: 'Đại diện: ', bold: true }, dots(A?.representative, SHORT_DOTS),
        '     Chức vụ: ', dots(A?.position, SHORT_DOTS),
      ],
      margin: [0, 1, 0, 1],
    } as Content,
    {
      text: [
        { text: 'Điện thoại: ', bold: true }, dots(A?.phone, SHORT_DOTS),
        '     Email: ', dots(A?.email, SHORT_DOTS),
      ],
      margin: [0, 1, 0, 1],
    } as Content,

    sectionTitle('BÊN B – BÊN THIẾT KẾ VÀ SẢN XUẤT (LUXE GLOW)'),
    { text: [{ text: 'Tên đăng ký kinh doanh: ', bold: true }, dots(B?.name), ' (thương hiệu: Luxe Glow)'], margin: [0, 1, 0, 1] } as Content,
    labelLine('Địa chỉ đăng ký', dots(B?.address)),
    labelLine('Mã số thuế / Số đăng ký', dots(B?.taxCode)),
    labelLine('Đại diện/chủ hộ', dots(B?.representative)),
    {
      text: [
        { text: 'Điện thoại: ', bold: true }, dots(B?.phone, SHORT_DOTS),
        '     Email: ', dots(B?.email, SHORT_DOTS),
      ],
      margin: [0, 1, 0, 1],
    } as Content,
    p('Sau khi thỏa thuận, Bên A và Bên B (sau đây gọi chung là “Hai Bên”) thống nhất ký kết Hợp đồng với các điều khoản sau:', { margin: [0, 4, 0, 2] }),

    articleTitle('Điều 1. Đối tượng và phạm vi hợp đồng'),
    clause('1.1.', 'Bên A giao và Bên B nhận thiết kế, sản xuất sản phẩm in 3D cho dự án JOYLOVE. Danh mục sản phẩm, số lượng, vật liệu, màu sắc, kích thước, đơn giá, tiêu chuẩn và phương án đóng gói được ghi tại Phụ lục 01, là bộ phận không tách rời của Hợp đồng.'),
    clause('1.2.', 'Sản phẩm được sản xuất theo mẫu thực tế/bản thiết kế hoặc mẫu tham chiếu được Bên A phê duyệt, cùng các yêu cầu kỹ thuật và dung sai chấp nhận ghi trong Phụ lục 01. Chỉ các thông số đã được hai bên xác nhận mới là cơ sở bắt buộc để đánh giá.'),
    clause('1.3.', 'Bên B không tự ý thay đổi vật liệu, màu sắc, kích thước, kết cấu, công năng hoặc thông số đã cam kết nếu thay đổi ảnh hưởng đến chất lượng sản phẩm, trừ khi Bên A chấp thuận bằng văn bản. Bên B được chủ động tối ưu thông số và quy trình kỹ thuật nội bộ (ví dụ: hướng in, nhiệt độ, tốc độ, support) với điều kiện sản phẩm đáp ứng yêu cầu đã duyệt.'),
    clause('1.4.', 'Bên A được từ chối nghiệm thu phần sản phẩm có sai lệch được xác định khách quan so với mẫu, bản vẽ hoặc tiêu chuẩn đã duyệt; việc khắc phục được thực hiện theo Điều 8 của Hợp đồng.'),

    articleTitle('Điều 2. Thiết kế, chỉnh sửa và phê duyệt mẫu'),
    clause('2.1.', 'Bên B thực hiện thiết kế 3D dựa trên thông tin, hình ảnh, mẫu hoặc dữ liệu do Bên A cung cấp; Bên A chịu trách nhiệm về tính chính xác và quyền sử dụng hợp pháp của các tài liệu này.'),
    clause('2.2.1.', 'Bên A được yêu cầu tối đa 05 vòng chỉnh sửa miễn phí trong phạm vi yêu cầu ban đầu đã thống nhất. Một vòng chỉnh sửa là một lần Bên A tổng hợp và gửi phản hồi đối với một phiên bản thiết kế do Bên B bàn giao; từ vòng thứ 06, phí chỉnh sửa là 50.000 đồng/vòng, nếu không thuộc trường hợp tại Điều 2.2.2 hoặc 2.2.3.'),
    clause('2.2.2.', 'Các sửa đổi nhằm khắc phục lỗi, thiếu sót hoặc nội dung không phù hợp yêu cầu đã được hai bên xác nhận do trách nhiệm của Bên B không tính vào số vòng miễn phí và không phát sinh chi phí bổ sung cho Bên A.'),
    clause('2.2.3.', 'Thay đổi vượt phạm vi thiết kế ban đầu, thay đổi đáng kể cấu trúc/công năng/độ phức tạp hoặc phát sinh công việc mới phải được hai bên thống nhất bằng văn bản về nội dung, chi phí và tiến độ trước khi thực hiện; không áp dụng mặc định mức 50.000 đồng/vòng đối với các thay đổi này.'),
    clause('2.3.', 'Bên B chỉ triển khai sản xuất hàng loạt sau khi Bên A xác nhận duyệt mẫu/thiết kế qua kênh quy định tại Điều 13 và sau khi Bên B nhận đủ thanh toán đợt 1. Phiên bản được duyệt phải có mã phiên bản hoặc tài liệu nhận diện rõ ràng.'),
    clause('2.4.', 'Thay đổi sau khi đã duyệt mẫu được xem là yêu cầu phát sinh. Hai Bên thống nhất lại chi phí, ảnh hưởng tiến độ và cách xử lý vật tư/sản phẩm đã làm trước khi thực hiện. Thời gian Bên A chậm cung cấp dữ liệu hoặc chậm duyệt mẫu làm gia hạn tiến độ tương ứng với ảnh hưởng thực tế.'),

    articleTitle('Điều 3. Giá trị hợp đồng, thuế và thanh toán'),
    clause('3.1.', `Tổng giá trị Hợp đồng: ${total} đồng (bằng chữ: ${numberToVietnameseWords(data.totalAmount)}). Đây là giá trọn gói cho phạm vi tại Phụ lục 01, đã tính đến nghĩa vụ thuế, phí mà Bên B phải thực hiện theo chế độ thuế thực tế áp dụng (nếu có), nhưng CHƯA bao gồm phí vận chuyển. Bên B cung cấp hóa đơn/chứng từ hợp pháp theo chế độ đăng ký; điều khoản này không đồng nghĩa với cam kết phát hành hóa đơn GTGT theo phương pháp khấu trừ nếu Bên B không thuộc đối tượng áp dụng.`),
    clause('3.2.', `Thanh toán bằng chuyển khoản hoặc hình thức hợp pháp khác mà hai bên thống nhất, chia thành ${String(schedule.length).padStart(2, '0')} đợt:`),
    ...paymentLines,
    clause('3.3.', `Tài khoản thụ hưởng: ${dots(data.bankAccountNumber)}; Ngân hàng: ${dots(data.bankName)}; Chủ tài khoản: ${dots(data.bankAccountHolder)}. Nội dung chuyển khoản ghi rõ mã Hợp đồng và đợt thanh toán.`),
    clause('3.4.', 'Mọi thay đổi làm phát sinh giá trị Hợp đồng chỉ có hiệu lực sau khi người có thẩm quyền của hai bên xác nhận qua kênh chính thức tại Điều 13.'),

    articleTitle('Điều 4. Tiến độ, giao hàng và nghiệm thu'),
    clause('4.1.', `Thời gian hoàn thiện thiết kế: ........ ngày làm việc kể từ khi Bên B nhận đủ tiền đợt 1 và dữ liệu đầu vào; thời gian sản xuất: ........ ngày làm việc kể từ ngày Bên A duyệt mẫu và các điều kiện khởi động sản xuất được đáp ứng. Lịch giao cụ thể: ${data.deliveryDate ? dmy(data.deliveryDate) : DOTS_LONG}. Bất kỳ điều chỉnh nào do Bên A chậm duyệt, thay đổi yêu cầu hoặc bất khả kháng được xử lý theo Điều 2 và Điều 12.`),
    clause('4.2.', `Địa điểm giao hàng: ${dots(data.deliveryAddress)}. Người nhận: ${SHORT_DOTS}. Phí vận chuyển do hai bên thỏa thuận và xác nhận bằng văn bản trước khi gửi hàng; không nằm trong giá trị Hợp đồng tại Điều 3.1.`),
    clause('4.3.1.', 'Bên B giao đúng số lượng, chất lượng, thông số, địa điểm và thời hạn đã thỏa thuận; thông báo trước thông tin lô hàng, hình thức vận chuyển và chứng từ giao nhận cần thiết.'),
    clause('4.3.2.', 'Khi nhận hàng, Bên A kiểm tra sơ bộ số lượng kiện, tình trạng bao bì và lỗi ngoại quan có thể phát hiện bằng kiểm tra thông thường. Việc ký nhận hàng không đồng nghĩa với nghiệm thu cuối cùng hoặc từ bỏ quyền khiếu nại lỗi tiềm ẩn.'),
    clause('4.3.3.', 'Bên A thông báo bằng văn bản các sai lệch số lượng/lỗi ngoại quan thông thường trong 05 ngày làm việc kể từ ngày nhận hàng, kèm bằng chứng. Nếu hết thời hạn này mà không có phản hồi hợp lệ, phần hàng không có khiếu nại được coi là đã nghiệm thu để xác định nghĩa vụ thanh toán; quyền bảo hành lỗi tiềm ẩn theo Điều 11 vẫn được bảo lưu.'),
    clause('4.3.4.', 'Lỗi kỹ thuật hoặc lỗi tiềm ẩn không thể nhận biết bằng kiểm tra thông thường được thông báo trong thời hạn bảo hành tại Điều 11, trừ khi hai bên có thỏa thuận khác hoặc pháp luật có quy định bắt buộc. Hai bên lập biên bản nghiệm thu theo mẫu Phụ lục 02 hoặc xác nhận tương đương qua kênh chính thức.'),
    clause('4.3.5.', 'Nếu Bên B giao hàng chậm do lỗi của mình, Bên A thông báo yêu cầu khắc phục trong thời hạn hợp lý. Quyền phạt vi phạm, bồi thường hoặc chấm dứt chỉ áp dụng khi có đủ điều kiện theo Hợp đồng và pháp luật; chậm trễ do Bên A hoặc sự kiện bất khả kháng được xem xét miễn/trừ trách nhiệm tương ứng theo quy định.'),
    clause('4.3.6.', 'Chi phí vận chuyển, đổi trả hoặc thay thế hàng không đạt do lỗi của Bên B do Bên B chịu. Đối với hư hỏng trong vận chuyển, trách nhiệm được xác định trên cơ sở nghĩa vụ đóng gói, bên tổ chức vận chuyển và thỏa thuận về thời điểm chuyển giao rủi ro tại Phụ lục 01.'),

    articleTitle('Điều 5. Tiêu chuẩn chất lượng, dung sai và đóng gói'),
    clause('5.1.', 'Sản phẩm phải đúng mẫu/phương án được duyệt, vật liệu, màu sắc, số lượng và công năng đã cam kết; không gãy, nứt, thiếu chi tiết ảnh hưởng công năng; bộ phận lắp ghép hoạt động theo yêu cầu; bề mặt làm sạch và phụ kiện/đóng gói theo Phụ lục 01.'),
    clause('5.2.', 'Dung sai kích thước, điều kiện ngoại quan, mức chấp nhận đường lớp in 3D, dấu support, sắc độ màu và phương pháp kiểm tra được quy định tại Phụ lục 01 hoặc mẫu thực tế đã duyệt. Không mặc nhiên áp dụng cùng một dung sai cho mọi kích thước hay bộ phận lắp ghép.'),
    clause('5.3.', 'Nếu một tiêu chí chất lượng chưa được thỏa thuận cụ thể, hai bên ưu tiên đối chiếu với mẫu đã được duyệt, đặc tính thông thường của công nghệ/vật liệu sản xuất và mục đích sử dụng đã được Bên A công bố. Việc đánh giá phải có căn cứ khách quan, không chỉ dựa trên cảm nhận chủ quan.'),

    articleTitle('Điều 6. Quyền và nghĩa vụ của các bên'),
    clause('6.1.', 'Bên A có trách nhiệm cung cấp chính xác tài liệu/mẫu/nhãn hiệu được phép sử dụng, phản hồi và duyệt mẫu trong thời hạn đã thống nhất; phối hợp xác minh lỗi; nhận hàng và thanh toán đúng hạn. Bên A chỉ sử dụng sản phẩm phù hợp mục đích và hướng dẫn đã được Bên B cung cấp.'),
    clause('6.2.1.', 'Bên B thiết kế, sản xuất đúng mẫu và tiêu chuẩn đã duyệt, bảo mật dữ liệu và thông báo kịp thời những trở ngại ảnh hưởng đáng kể đến tiến độ. Bên B không giao phần việc cốt lõi cho bên thứ ba nếu việc thuê ngoài ảnh hưởng đến bí mật hoặc chất lượng mà chưa được Bên A đồng ý; có thể sử dụng dịch vụ phụ trợ thông thường với điều kiện vẫn chịu trách nhiệm về kết quả.'),
    clause('6.2.2.', 'Bên B chịu trách nhiệm đối với lỗi sản phẩm và các hành vi vi phạm thuộc trách nhiệm của mình theo phạm vi Hợp đồng.'),
    clause('6.2.3.', 'Bên B không tự ý sử dụng tên, nhãn hiệu, logo, hình ảnh mẫu hoặc hình ảnh sản phẩm JOYLOVE trên website, mạng xã hội, hồ sơ năng lực, tài liệu chào bán hoặc quảng cáo khi chưa có sự đồng ý bằng văn bản của Bên A.'),

    articleTitle('Điều 7. Chậm thanh toán và tạm ngừng công việc'),
    clause('7.1.', 'Trường hợp khoản thanh toán đến hạn không được thực hiện đầy đủ và không có tranh chấp hợp lệ, Bên B gửi thông báo bằng văn bản yêu cầu Bên A thanh toán, đồng thời dành tối thiểu 05 ngày làm việc để khắc phục kể từ khi Bên A nhận được thông báo.'),
    clause('7.2.', 'Hết thời hạn khắc phục mà Bên A vẫn không thanh toán, Bên B được tạm ngừng phần công việc/giao hàng chưa thực hiện sau khi thông báo; tiến độ tương ứng được gia hạn theo thời gian bị ảnh hưởng và Bên B được yêu cầu lãi chậm trả, bồi thường hoặc biện pháp khác theo Điều 14.2 và pháp luật.'),
    clause('7.3.', 'Việc tạm ngừng phải tương xứng với vi phạm, không làm mất quyền khiếu nại, nghiệm thu và bảo hành đối với phần hàng đã giao theo Hợp đồng.'),

    articleTitle('Điều 8. Xử lý sản phẩm không đạt chất lượng'),
    clause('8.1.1.', 'Khi phát sinh sản phẩm không đạt số lượng, chất lượng, thông số hoặc mẫu đã duyệt mà nguyên nhân thuộc Bên B, hai bên xác minh lỗi trên cơ sở tiêu chuẩn và dung sai đã được thống nhất; mỗi bên có trách nhiệm phối hợp và cung cấp chứng cứ liên quan.'),
    clause('8.1.2.', 'Bên A gửi thông báo trong thời hạn quy định tại Điều 4 và Điều 11, kèm ảnh, video hoặc tài liệu xác minh; Bên B phản hồi trong 03 ngày làm việc kể từ khi nhận đủ thông tin cần thiết.'),
    clause('8.1.3.', 'Bên B được ưu tiên lựa chọn phương án phù hợp để khắc phục: (a) sửa chữa/hoàn thiện; (b) sản xuất bù/thay thế sản phẩm lỗi; hoặc (c) đề xuất giảm giá đối với sai lệch không ảnh hưởng công năng nếu Bên A chấp thuận. Thời hạn khắc phục được hai bên thống nhất bằng văn bản, căn cứ vào tính chất lỗi, số lượng và năng lực sản xuất thực tế.'),
    clause('8.1.4.', 'Nếu Bên B không thể khắc phục, không khắc phục trong thời hạn đã thống nhất mà không có lý do hợp lệ, hoặc sản phẩm sau khắc phục vẫn không đáp ứng yêu cầu, Bên A có quyền từ chối phần sản phẩm không đạt và yêu cầu hoàn trả giá trị tương ứng. Quyền áp dụng chế tài khác trong trường hợp vi phạm nghiêm trọng hoặc pháp luật có quy định được bảo lưu.'),
    clause('8.1.5.', 'Bên B chịu chi phí hợp lý cho việc sửa chữa, sản xuất bù, thay thế và giao nhận/đổi trả hàng lỗi do mình gây ra. Không áp dụng trùng lặp các biện pháp dẫn đến Bên A được hoàn tiền cho toàn bộ phần hàng lỗi đồng thời vẫn nhận phần thay thế đạt chất lượng mà không có căn cứ phù hợp.'),
    clause('8.1.6.', 'Bên A có quyền yêu cầu phạt vi phạm và bồi thường thiệt hại khi có đủ căn cứ theo Hợp đồng và pháp luật. Thiệt hại phải được chứng minh, có quan hệ nhân quả trực tiếp và áp dụng nghĩa vụ hạn chế tổn thất; không bồi hoàn hai lần cho cùng một khoản thiệt hại.'),
    clause('8.1.7.', 'Các trường hợp loại trừ trách nhiệm tại Điều 8.2 chỉ được áp dụng khi có căn cứ chứng minh nguyên nhân lỗi không thuộc trách nhiệm của Bên B.'),
    clause('8.2.', 'Bên B không chịu trách nhiệm đối với hư hỏng do Bên A hoặc người sử dụng dùng sai công năng; bảo quản trái hướng dẫn hợp lý; để tiếp xúc với nhiệt độ, hóa chất, tải trọng vượt giới hạn đã công bố; tự ý sửa đổi kết cấu; hao mòn tự nhiên; lỗi trong tài liệu hoặc thiết kế do Bên A cung cấp mà Bên B không có nghĩa vụ phải phát hiện theo thỏa thuận; hoặc sự cố vận chuyển không thuộc trách nhiệm Bên B. Quy định này không loại trừ trách nhiệm của Bên B đối với lỗi do chính mình gây ra.'),

    articleTitle('Điều 9. Sở hữu trí tuệ và bảo mật'),
    clause('9.1.', 'Quyền sở hữu đối với file thiết kế được sáng tạo riêng cho dự án JOYLOVE và đã nằm trong phạm vi giá Hợp đồng được chuyển giao cho Bên A sau khi Bên A thanh toán đầy đủ, trừ nội dung có thỏa thuận khác và quyền nhân thân không thể chuyển giao theo luật. Danh sách file và định dạng bàn giao xác định tại Phụ lục 01.'),
    clause('9.2.', 'Các công cụ, thư viện, mẫu nền, phương pháp, module và tài sản trí tuệ có trước hoặc phát triển độc lập của Bên B không tự động được chuyển giao. Trong phạm vi cần thiết để Bên A khai thác sản phẩm/thiết kế đã thanh toán, Bên B cấp quyền sử dụng các thành phần được tích hợp theo mục đích đã thỏa thuận, trừ trường hợp có hạn chế từ chủ sở hữu hợp pháp khác đã được thông báo trước.'),
    clause('9.3.', 'Bên B không sử dụng file thiết kế riêng, mẫu sản phẩm mang nhận diện JOYLOVE hoặc nhãn hiệu JOYLOVE để sản xuất, mua bán, đăng tải hoặc quảng cáo ngoài phạm vi thực hiện Hợp đồng nếu chưa được Bên A chấp thuận bằng văn bản.'),
    clause('9.4.', 'Bên A cam kết có quyền sử dụng hợp pháp đối với hình ảnh, nhãn hiệu, mẫu, thiết kế và tài liệu cung cấp cho Bên B. Mỗi bên chịu trách nhiệm đối với hành vi xâm phạm quyền sở hữu trí tuệ do mình gây ra.'),
    clause('9.5.', 'Mỗi bên giữ bí mật thông tin thương mại, bản vẽ, dữ liệu và giá cả chưa công khai của bên kia, trừ khi phải cung cấp theo pháp luật, được chủ sở hữu đồng ý hoặc thông tin đã công khai hợp pháp không do lỗi bên nhận. Nghĩa vụ bảo mật tiếp tục có hiệu lực 02 năm sau khi Hợp đồng chấm dứt, trừ dữ liệu được pháp luật bảo vệ dài hơn.'),

    articleTitle('Điều 10. Mục đích sử dụng và giới hạn kỹ thuật'),
    clause('10.1.', 'Trừ khi được thống nhất và thử nghiệm/chứng nhận theo tiêu chuẩn liên quan, sản phẩm không mặc nhiên phù hợp cho ứng dụng an toàn nghiêm ngặt như thiết bị y tế, bộ phận an toàn phương tiện, vật chịu tải lớn, thiết bị điện/phòng cháy chữa cháy, sản phẩm tiếp xúc trực tiếp thực phẩm, đồ chơi trẻ nhỏ, dụng cụ bảo hộ hoặc điều kiện nhiệt độ cao.'),
    clause('10.2.', 'Bên A phải thông báo trước nếu sản phẩm có mục đích sử dụng đặc biệt. Bên B chỉ chịu trách nhiệm về các yêu cầu đặc biệt đã được ghi nhận bằng văn bản và nằm trong phạm vi thử nghiệm/kiểm tra đã thỏa thuận.'),

    articleTitle('Điều 11. Bảo hành'),
    clause('11.1.', 'Thời hạn bảo hành là 30 ngày kể từ ngày nghiệm thu tương ứng đối với mỗi phần hàng. Đối với sản phẩm được thay thế do lỗi bảo hành, thời hạn bảo hành của sản phẩm thay thế là 30 ngày kể từ ngày Bên A nhận hàng thay thế.'),
    clause('11.2.', 'Bảo hành các lỗi thuộc trách nhiệm sản xuất/lắp ráp của Bên B, bao gồm gãy, nứt, tách lớp, thiếu phụ kiện hoặc sản phẩm không thực hiện được công năng đã cam kết do lỗi sản xuất. Việc thông báo, xác minh và khắc phục thực hiện theo Điều 8.'),
    clause('11.3.', 'Không bảo hành hao mòn hoặc trầy xước do sử dụng; hư hỏng do rơi, va đập, tải trọng, nhiệt, nước/hóa chất ngoài mục đích thiết kế; việc sửa đổi trái hướng dẫn; hoặc khác biệt ngoại quan nằm trong giới hạn đã được duyệt tại Phụ lục 01. Các loại trừ chỉ áp dụng khi có căn cứ xác định nguyên nhân.'),

    articleTitle('Điều 12. Bất khả kháng'),
    clause('12.1.', 'Bất khả kháng là sự kiện xảy ra khách quan, không thể lường trước và không thể khắc phục dù đã áp dụng biện pháp cần thiết trong khả năng cho phép theo pháp luật, ví dụ thiên tai nghiêm trọng, hỏa hoạn không do lỗi chủ quan, chiến tranh hoặc quyết định của cơ quan nhà nước trực tiếp cản trở thực hiện nghĩa vụ.'),
    clause('12.2.', 'Bên bị ảnh hưởng thông báo sớm cho bên còn lại, nêu mức độ ảnh hưởng và bằng chứng hợp lý, thực hiện biện pháp hạn chế thiệt hại và tiếp tục nghĩa vụ khi trở ngại chấm dứt. Khó khăn thông thường về nhân sự, vật tư hoặc dòng tiền không mặc nhiên là bất khả kháng nếu không đáp ứng điều kiện pháp luật.'),
    clause('12.3.', 'Tiến độ được gia hạn tương ứng với khoảng thời gian bị ảnh hưởng trực tiếp. Nếu sự kiện kéo dài trên 05 ngày làm việc, hai bên trao đổi phương án điều chỉnh; nếu kéo dài quá 20 ngày làm việc và không thống nhất được cách tiếp tục, mỗi bên có quyền đề nghị chấm dứt, quyết toán theo phần nghĩa vụ đã thực hiện và quy định pháp luật.'),
    clause('12.4.', 'Khi Hợp đồng chấm dứt hợp pháp do bất khả kháng, các khoản đã thanh toán cho phần nghĩa vụ chưa thực hiện mà không có căn cứ pháp lý để giữ được hoàn trả sau khi xác định chi phí hợp lý, quyền và nghĩa vụ của mỗi bên theo Hợp đồng và quy định pháp luật.'),

    articleTitle('Điều 13. Thông báo, phê duyệt và chứng cứ điện tử'),
    clause('13.1.', 'Hai bên thống nhất sử dụng email, Zalo, tài liệu điện tử, chữ ký điện tử hoặc hệ thống quản lý hợp đồng của Bên B (bao gồm việc Bên A truy cập đường dẫn bảo mật để xem và ký Hợp đồng) từ tài khoản/người đại diện được chỉ định để gửi yêu cầu, duyệt mẫu, xác nhận phát sinh, nghiệm thu và thông báo. Việc ký và xác nhận điện tử phải bảo đảm nhận diện người ký, thể hiện sự chấp thuận đối với nội dung Hợp đồng và đáp ứng điều kiện có hiệu lực theo pháp luật. Nhật ký giao dịch, thời điểm ký và bản PDF đã ký được lưu để đối chiếu khi cần.'),
    clause('13.2.', `Kênh liên hệ chính thức Bên A: email ${dots(A?.email, SHORT_DOTS)}; số điện thoại/Zalo ${dots(A?.phone, SHORT_DOTS)}; người phụ trách ${dots(partyAName(A), SHORT_DOTS)}.`),
    clause('13.3.', `Kênh liên hệ chính thức Bên B: email ${dots(B?.email, SHORT_DOTS)}; số điện thoại/Zalo ${dots(B?.phone, SHORT_DOTS)}; người phụ trách ${dots(B?.representative || B?.name, SHORT_DOTS)}.`),
    clause('13.4.', 'Mỗi bên phải thông báo khi thay đổi thông tin liên hệ. Xác nhận từ tài khoản không nằm trong danh sách chính thức chỉ có hiệu lực sau khi được bên có thẩm quyền xác nhận lại.'),

    articleTitle('Điều 14. Hủy bỏ, chấm dứt hợp đồng và chậm thanh toán'),
    clause('14.1.1.', 'Trường hợp Bên A chấm dứt/hủy bỏ do lỗi của Bên B: (a) nếu Bên B vi phạm nghiêm trọng nghĩa vụ làm ảnh hưởng mục đích giao kết Hợp đồng, Bên A thông báo và cho Bên B tối thiểu 05 ngày làm việc để khắc phục, trừ vi phạm không thể khắc phục hoặc trường hợp pháp luật cho phép chấm dứt/hủy bỏ ngay; (b) nếu Bên B không khắc phục hợp lệ, Bên A được chấm dứt/hủy bỏ theo thỏa thuận và pháp luật; (c) việc hoàn trả khoản đã thanh toán tương ứng với phần nghĩa vụ chưa thực hiện/không đạt và xử lý phần công việc đã làm tuân theo hậu quả pháp lý của hình thức chấm dứt/hủy bỏ được áp dụng; (d) Bên A được yêu cầu chế tài khác khi có đủ căn cứ.'),
    clause('14.1.2.', 'Trường hợp Bên A tự chấm dứt vì lý do riêng không xuất phát từ lỗi Bên B: Bên A phải thông báo bằng văn bản; Bên B dừng các công việc chưa cần thiết và hợp lý hạn chế phát sinh. Hai bên quyết toán (i) giá trị thiết kế/sản phẩm/công việc đã hoàn thành phù hợp Hợp đồng; (ii) chi phí vật liệu, gia công, sản xuất thử và các chi phí hợp lý thực tế phát sinh, có chứng từ hoặc tài liệu chứng minh, không thể thu hồi hoặc sử dụng hợp lý cho đơn hàng khác; (iii) các nghĩa vụ hợp pháp khác đã được thỏa thuận. Không tính trùng chi phí đã nằm trong giá trị công việc hoàn thành.'),
    clause('14.1.3.', 'Khoản Bên A đã thanh toán được đối trừ vào giá trị quyết toán tại Điều 14.1.2; Bên B hoàn lại phần chênh lệch nếu đã nhận vượt, hoặc Bên A thanh toán bổ sung phần còn thiếu. Bên B gửi bảng quyết toán và tài liệu chứng minh trong 05 ngày làm việc từ ngày nhận thông báo chấm dứt; Bên A phản hồi trong 05 ngày làm việc kể từ ngày nhận đủ hồ sơ; phần tiền hai bên đã thống nhất được thanh toán/hoàn lại trong 07 ngày làm việc sau khi ký biên bản quyết toán.'),
    clause('14.1.4.', 'Tài liệu chứng minh chi phí có thể là đơn hàng, chứng từ mua vật tư, chứng từ thanh toán, file thiết kế, ảnh/video, nhật ký sản xuất, hồ sơ tiến độ và giấy tờ liên quan. Nếu có tranh chấp giá trị quyết toán, hai bên thực hiện thương lượng theo Điều 15; phần tiền không có tranh chấp vẫn phải được thanh toán đúng hạn.'),
    clause('14.2.1.', 'Nếu Bên A chậm thanh toán khoản đến hạn không có tranh chấp hợp lệ, Bên B gửi văn bản yêu cầu thanh toán và dành ít nhất 05 ngày làm việc để khắc phục. Hết thời hạn mà Bên A không thanh toán, Bên B được áp dụng Điều 7, yêu cầu lãi chậm trả và biện pháp khác theo Hợp đồng và pháp luật.'),
    clause('14.2.2.', 'Phạt vi phạm (nếu có) chỉ được áp dụng khi có thỏa thuận hợp pháp cụ thể và không vượt giới hạn pháp luật áp dụng; đối với quan hệ thuộc Luật Thương mại, mức phạt thông thường không quá 8% giá trị phần nghĩa vụ bị vi phạm. Không áp dụng mức phạt 200% giá trị hợp đồng hoặc mức phạt tự động trên toàn bộ giá trị hợp đồng khi không có căn cứ.'),

    articleTitle('Điều 15. Giải quyết tranh chấp và điều khoản chung'),
    clause('15.1.', 'Hai bên ưu tiên thương lượng/hòa giải trong vòng 15 ngày làm việc kể từ ngày một bên thông báo tranh chấp. Nếu không giải quyết được, tranh chấp được đưa ra Tòa án có thẩm quyền theo quy định pháp luật Việt Nam.'),
    clause('15.2.', 'Hợp đồng có hiệu lực kể từ thời điểm bên ký sau cùng hoàn tất việc ký hợp lệ (ký trực tiếp hoặc ký điện tử đáp ứng điều kiện pháp luật), trừ khi hai bên xác nhận một ngày có hiệu lực khác. Đối với chữ ký thông qua hệ thống quản lý hợp đồng, thời điểm ký được xác định theo hồ sơ giao dịch do hệ thống ghi nhận. Mọi sửa đổi, bổ sung phải được người có thẩm quyền của hai bên xác nhận theo hình thức phù hợp pháp luật. Trong trường hợp mâu thuẫn, văn bản sửa đổi ký sau cùng được ưu tiên đối với phạm vi sửa đổi; Phụ lục 01 là căn cứ xác định thông số sản phẩm.'),
    clause('15.3.', 'Hợp đồng bao gồm 15 điều và Phụ lục 01 (Thông số đơn hàng - nghiệm thu), Phụ lục 02 (Biên bản giao nhận - nghiệm thu). Các phụ lục là bộ phận không tách rời của bản PDF mà Bên A truy cập và ký qua đường dẫn bảo mật. Bản PDF được ký điện tử hợp lệ có giá trị theo pháp luật; trường hợp ký giấy, Hợp đồng được lập 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.'),

    signatureColumns('ĐẠI DIỆN', '(Ký trực tiếp hoặc ký điện tử hợp lệ)', [
      partyAName(A),
      B?.representative || B?.name || '',
    ]),

    // ── Phụ lục 01 ──
    { text: 'PHỤ LỤC 01', alignment: 'center', bold: true, color: NAVY, pageBreak: 'before' },
    { text: 'DANH MỤC ĐƠN HÀNG – THÔNG SỐ VÀ TIÊU CHUẨN NGHIỆM THU', alignment: 'center', bold: true, color: NAVY, margin: [0, 2, 0, 6] },
    p(`Đính kèm Hợp đồng số ${dots(data.contractNo)}. Phụ lục này phải được hai bên hoàn thiện và xác nhận trước khi sản xuất hàng loạt.`),

    sectionTitle('A. Danh mục sản phẩm và giá trị đơn hàng'),
    {
      table: {
        headerRows: 1,
        widths: [26, '*', 50, 75, 80],
        body: [
          [th('STT'), th('Mã/tên sản phẩm'), th('SL (cái)'), th('Đơn giá (đ)'), th('Thành tiền (đ)')],
          ...itemRows,
          [
            '',
            { text: 'TỔNG GIÁ TRỊ HỢP ĐỒNG', bold: true },
            '',
            '',
            { text: total, alignment: 'right', bold: true },
          ],
        ],
      },
      layout: tableLayout,
      fontSize: 9.5,
      margin: [0, 2, 0, 4],
    },
    p(`Ghi chú: Tổng các dòng hàng hóa/dịch vụ phải khớp ${total} đồng; không bao gồm phí vận chuyển. Nếu có phí thiết kế riêng, ghi thành một dòng trong bảng.`),

    sectionTitle('B. Thông số kỹ thuật và đối chứng duyệt mẫu'),
    {
      table: {
        headerRows: 1,
        widths: [190, '*'],
        body: [[th('Nội dung'), th('Thông tin được hai bên xác nhận')], ...specRows],
      },
      layout: tableLayout,
      fontSize: 9.5,
      margin: [0, 2, 0, 4],
    },

    sectionTitle('C. Lịch thực hiện và giao nhận'),
    {
      table: {
        headerRows: 1,
        widths: [190, '*'],
        body: [[th('Mốc công việc'), th('Ngày/mốc xác nhận')], ...scheduleRows],
      },
      layout: tableLayout,
      fontSize: 9.5,
      margin: [0, 2, 0, 4],
    },
    p(`Mẫu/thiết kế được duyệt (ghi mã, phiên bản hoặc đường dẫn lưu trữ): ${DOTS_LONG}`),
    {
      columns: [
        { alignment: 'center', stack: [{ text: 'XÁC NHẬN BÊN A – JOYLOVE', bold: true, color: NAVY }, `Ký/xác nhận: ${SHORT_DOTS}`] },
        { alignment: 'center', stack: [{ text: 'XÁC NHẬN BÊN B – LUXE GLOW', bold: true, color: NAVY }, `Ký/xác nhận: ${SHORT_DOTS}`] },
      ],
      margin: [0, 10, 0, 0],
    },

    // ── Phụ lục 02 ──
    { text: 'PHỤ LỤC 02', alignment: 'center', bold: true, color: NAVY, pageBreak: 'before' },
    { text: 'BIÊN BẢN GIAO NHẬN VÀ NGHIỆM THU SẢN PHẨM', alignment: 'center', bold: true, color: NAVY, margin: [0, 2, 0, 6] },
    p(`Áp dụng cho Hợp đồng số ${dots(data.contractNo)} - Dự án JOYLOVE`),
    { text: [{ text: 'Ngày, giờ giao nhận: ', bold: true }, SHORT_DOTS, '     Địa điểm: ', DOTS_LONG], margin: [0, 1, 0, 1] } as Content,
    labelLine('Đại diện Bên A nhận hàng', DOTS_LONG),
    labelLine('Đại diện Bên B/giao hàng', DOTS_LONG),
    labelLine('Số phiếu giao hàng/vận đơn', DOTS_LONG),

    sectionTitle('1. Danh sách hàng giao và kết quả kiểm tra'),
    {
      table: {
        headerRows: 1,
        widths: ['*', 50, 50, 65, 140],
        body: [
          [th('Mã/tên hàng'), th('SL giao'), th('SL đạt'), th('SL cần xử lý'), th('Ghi chú lỗi/hồ sơ ảnh')],
          ...handoverRows,
        ],
      },
      layout: tableLayout,
      fontSize: 9.5,
      margin: [0, 2, 0, 4],
    },

    sectionTitle('2. Xác nhận'),
    p('[  ] Đã nhận hàng và nghiệm thu toàn bộ theo tiêu chuẩn đã thỏa thuận.', { margin: [0, 1, 0, 1] }),
    p('[  ] Đã nhận hàng, nghiệm thu phần đạt; phần chưa đạt được ghi rõ trong bảng trên.', { margin: [0, 1, 0, 1] }),
    p('[  ] Mới xác nhận giao nhận sơ bộ, chưa kết thúc thời hạn kiểm tra theo Điều 4.3.', { margin: [0, 1, 0, 1] }),
    p(`Mô tả lỗi, số lượng và yêu cầu xử lý: ${DOTS_LONG}${DOTS_LONG}`),
    p(`Thời hạn dự kiến khắc phục (nếu có): ${DOTS_LONG}`),
    p(`Giá trị phần được nghiệm thu để thanh toán: ${DOTS_LONG} đồng.`),
    p('Ngày bắt đầu bảo hành của phần nghiệm thu: ……/……/…………'),
    p('Việc ký biên bản giao nhận sơ bộ không làm mất quyền thông báo lỗi tiềm ẩn trong thời hạn bảo hành theo Hợp đồng.'),
    signatureColumns('ĐẠI DIỆN', '(Ký trực tiếp hoặc ký điện tử hợp lệ)'),
  ];

  return {
    pageSize: 'A4',
    pageMargins: [45, 48, 45, 44],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25 },
    header: () => ({
      text: 'HỢP ĐỒNG THIẾT KẾ & SẢN XUẤT IN 3D  |  DỰ ÁN JOYLOVE',
      alignment: 'right',
      fontSize: 7.5,
      color: '#6b7280',
      margin: [45, 22, 45, 0],
    }),
    footer: (currentPage: number) => ({
      text: `JOYLOVE – LUXE GLOW • Trang ${currentPage}`,
      alignment: 'center',
      fontSize: 7.5,
      color: '#6b7280',
      margin: [0, 14, 0, 0],
    }),
    content,
    info: {
      title: `Hop dong ${data.contractNo}`,
      author: 'Luxe Glow',
    },
  };
}
