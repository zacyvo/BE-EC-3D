import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { StaffModule } from './staff/staff.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { AuditModule } from './audit/audit.module';
import { UploadModule } from './upload/upload.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ExternalRevenueModule } from './external-revenue/external-revenue.module';
import { CacheModule } from './common/cache.module';
import { MailModule } from './mail/mail.module';
import { CustomOrdersModule } from './custom-orders/custom-orders.module';
import { PromotionsModule } from './promotions/promotions.module';
import { InvoicesModule } from './invoices/invoices.module';
import { WarehouseExportsModule } from './warehouse-exports/warehouse-exports.module';
import { FilamentsModule } from './filaments/filaments.module';
import { ContractsModule } from './contracts/contracts.module';
import { LocationsModule } from './locations/locations.module';
import { EInvoiceModule } from './einvoice/einvoice.module';
import { PrintPlansModule } from './print-plans/print-plans.module';
import { ShopeeSyncModule } from './shopee-sync/shopee-sync.module';
import { SettingsModule } from './settings/settings.module';
import { NfcModule } from './nfc/nfc.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
        connectionFactory: (connection: any) => {
          connection.on('connected', () => console.log('✅ MongoDB connected'));
          connection.on('error', (err: Error) => console.error('❌ MongoDB error:', err));
          return connection;
        },
      }),
      inject: [ConfigService],
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: configService.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
      inject: [ConfigService],
    }),

    // Cache (Redis)
    CacheModule,

    // Feature modules
    AuthModule,
    UsersModule,
    StaffModule,
    ProductsModule,
    CategoriesModule,
    CartModule,
    OrdersModule,
    AuditModule,
    UploadModule,
    AnalyticsModule,
    ExternalRevenueModule,
    MailModule,
    CustomOrdersModule,
    PromotionsModule,
    InvoicesModule,
    WarehouseExportsModule,
    FilamentsModule,
    ContractsModule,
    LocationsModule,
    EInvoiceModule,
    PrintPlansModule,
    ShopeeSyncModule,
    SettingsModule,
    NfcModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
