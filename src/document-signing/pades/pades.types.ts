/**
 * Kết quả xác thực 1 chữ ký PAdES/CMS nhúng trong PDF.
 *
 * GIỚI HẠN QUAN TRỌNG (MVP): chainValidated luôn là false — chỉ xác thực được tính toàn vẹn
 * (digestValid) và tính xác thực chữ ký (signatureValid) bằng certificate NHÚNG SẴN trong file,
 * KHÔNG xác minh chuỗi tin cậy lên CA gốc (VNPT-CA/VGCA/Viettel-CA…) và KHÔNG kiểm tra thu hồi
 * (CRL/OCSP). Admin cần đối chiếu thủ công signerCertIssuer/signerCertCN trước khi tin tưởng.
 */
export interface PadesSignatureInfo {
  /** ByteRange có cấu trúc hợp lệ (bắt đầu từ 0, các khoảng không chồng lấn) */
  byteRangeValid: boolean;
  /** true nếu ByteRange của chữ ký này phủ đến hết file hiện tại (chữ ký mới nhất/ngoài cùng) */
  coversToEndOfFile: boolean;
  /** Digest tính lại từ nội dung ByteRange khớp với messageDigest trong CMS signed attributes */
  digestValid: boolean;
  /** Chữ ký RSA verify thành công bằng public key trong certificate nhúng kèm */
  signatureValid: boolean;
  signerCertCN: string;
  signerCertSerial: string;
  signerCertIssuer: string;
  certNotBefore?: Date;
  certNotAfter?: Date;
  /** notBefore <= (thời điểm verify) <= notAfter — KHÔNG đồng nghĩa cert đáng tin cậy */
  certCurrentlyValid: boolean;
  signingTime?: Date;
  subFilter: string;
  rawCertPem: string;
  /** Luôn false ở MVP — xem giới hạn ở trên */
  chainValidated: false;
}
