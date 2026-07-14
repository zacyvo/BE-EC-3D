import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ContractsService } from './contracts.service';
import {
  AdminContractsController,
  PublicContractsController,
} from './contracts.controller';
import { Contract, ContractSchema } from './schemas/contract.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { UsersModule } from '../users/users.module';
import { StaffModule } from '../staff/staff.module';
import { AuditModule } from '../audit/audit.module';
import { ExternalRevenueModule } from '../external-revenue/external-revenue.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Contract.name, schema: ContractSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    JwtModule.register({}),
    UsersModule,
    StaffModule,
    AuditModule,
    ExternalRevenueModule, // exports ExternalRevenue model — dùng ghi nhận tài chính khi SUCCESS
  ],
  controllers: [AdminContractsController, PublicContractsController],
  providers: [ContractsService],
})
export class ContractsModule {}
