import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { EInvoiceService } from './einvoice.service';
import { EasyInvoiceClientService } from './easyinvoice-client.service';
import {
  AdminEInvoiceController,
  ContractEInvoiceController,
  PublicEInvoiceController,
} from './einvoice.controller';
import { EInvoice, EInvoiceSchema } from './schemas/einvoice.schema';
import { Contract, ContractSchema } from '../contracts/schemas/contract.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { StaffModule } from '../staff/staff.module';
import { ContractsModule } from '../contracts/contracts.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EInvoice.name, schema: EInvoiceSchema },
      // Đăng ký thêm 2 schema đã thuộc module khác để đọc dữ liệu liên kết
      // (khoá bảo mật hợp đồng, snapshot đơn hàng) — cùng cách ContractsModule
      // đang làm với Product.
      { name: Contract.name, schema: ContractSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    JwtModule.register({}),
    StaffModule,
    AuditModule,
    ContractsModule,
  ],
  controllers: [AdminEInvoiceController, PublicEInvoiceController, ContractEInvoiceController],
  providers: [EInvoiceService, EasyInvoiceClientService],
})
export class EInvoiceModule {}
