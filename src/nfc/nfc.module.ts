import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { NfcService } from './nfc.service';
import { AdminNfcController, PublicNfcController } from './nfc.controller';
import { NfcProfile, NfcProfileSchema } from './schemas/nfc-profile.schema';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: NfcProfile.name, schema: NfcProfileSchema }]),
    JwtModule.register({}),
    AuditModule,
  ],
  controllers: [AdminNfcController, PublicNfcController],
  providers: [NfcService],
})
export class NfcModule {}
