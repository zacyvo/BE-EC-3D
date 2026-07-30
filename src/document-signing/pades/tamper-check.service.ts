import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * Đảm bảo file PDF mới upload là bản "incremental update" nối thêm từ file trước đó — không sửa
 * bất kỳ byte nào trong phần đã tồn tại. Đây là cách PDF signature hoạt động (mỗi lần ký chỉ nối
 * thêm 1 revision mới), nên đây cũng là cách duy nhất để đảm bảo Bên B/Bên A ký đúng bản hệ thống
 * đã tạo ra, không phải một bản nội dung khác đã bị chỉnh sửa.
 */
@Injectable()
export class TamperCheckService {
  assertIncrementalOnly(previousPdf: Buffer, newPdf: Buffer): void {
    if (newPdf.length <= previousPdf.length) {
      throw new BadRequestException(
        'File tải lên không lớn hơn bản gốc — có vẻ không phải bản đã ký (chưa có chữ ký mới được nối thêm)',
      );
    }
    if (!newPdf.subarray(0, previousPdf.length).equals(previousPdf)) {
      throw new BadRequestException(
        'Nội dung file đã bị thay đổi so với bản gốc hệ thống đã tạo — không thể chấp nhận. Vui lòng ký trực tiếp trên file gốc tải từ hệ thống, không chỉnh sửa nội dung.',
      );
    }
  }
}
