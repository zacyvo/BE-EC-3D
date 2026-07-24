const VN_DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const VN_SCALES = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ', ' triệu tỷ'];

function readTriple(n: number, isFirstGroup: boolean): string {
  const hundred = Math.floor(n / 100);
  const ten = Math.floor((n % 100) / 10);
  const unit = n % 10;
  const parts: string[] = [];

  if (!isFirstGroup || hundred > 0) {
    parts.push(VN_DIGITS[hundred], 'trăm');
  }

  if (ten === 0) {
    if (unit > 0) {
      if (hundred > 0 || !isFirstGroup) parts.push('lẻ');
      parts.push(VN_DIGITS[unit]);
    }
  } else if (ten === 1) {
    parts.push('mười');
    if (unit === 5) parts.push('lăm');
    else if (unit > 0) parts.push(VN_DIGITS[unit]);
  } else {
    parts.push(VN_DIGITS[ten], 'mươi');
    if (unit === 1) parts.push('mốt');
    else if (unit === 4) parts.push('tư');
    else if (unit === 5) parts.push('lăm');
    else if (unit > 0) parts.push(VN_DIGITS[unit]);
  }

  return parts.join(' ');
}

/** VD: 12500000 -> "Mười hai triệu năm trăm nghìn đồng" — dùng cho thẻ <AmountInWords> */
export function numberToVietnameseWords(amount: number): string {
  const n = Math.floor(Math.abs(amount || 0));
  if (n === 0) return 'Không đồng';

  const triples: number[] = [];
  let rest = n;
  while (rest > 0) {
    triples.unshift(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const total = triples.length;
  const words: string[] = [];
  triples.forEach((triple, idx) => {
    if (triple === 0) return;
    const scale = VN_SCALES[total - idx - 1] ?? '';
    words.push(readTriple(triple, idx === 0) + scale);
  });

  const sentence = words.join(' ').replace(/\s+/g, ' ').trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ' đồng';
}
