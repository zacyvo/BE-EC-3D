import { Controller, Get } from '@nestjs/common';
import { BankTransferService } from './bank-transfer.service';

/** Public: lets checkout decide whether to offer "Chuyển khoản ngân hàng (VietQR)". Exposes no
 * account details — those are only returned per order, to its owner. */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly bankTransfer: BankTransferService) {}

  @Get('bank-transfer/availability')
  availability() {
    return { enabled: this.bankTransfer.isAvailable() };
  }
}
