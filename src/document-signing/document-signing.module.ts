import { Module } from '@nestjs/common';
import { PdfGenerationService } from './pdf-generation/pdf-generation.service';
import { PadesVerifyService } from './pades/pades-verify.service';
import { TamperCheckService } from './pades/tamper-check.service';
import { DocumentStorageService } from './storage/document-storage.service';
import { PdfInspectService } from './pdfjs/pdf-inspect.service';
import { PadesSignService } from './pades/pades-sign.service';
import { SignaturePlacementService } from './pades/signature-placement.service';
import { SigningCredentialsService } from './pades/signing-credentials.service';

/**
 * Module ký số (PAdES) — độc lập với ContractsModule để có thể tái dùng cho EInvoice (hoá đơn
 * bán hàng nội bộ) sau này mà không cần viết lại logic PDF/crypto.
 */
@Module({
  providers: [
    PdfGenerationService,
    PadesVerifyService,
    TamperCheckService,
    DocumentStorageService,
    PdfInspectService,
    PadesSignService,
    SignaturePlacementService,
    SigningCredentialsService,
  ],
  exports: [
    PdfGenerationService,
    PadesVerifyService,
    TamperCheckService,
    DocumentStorageService,
    PdfInspectService,
    PadesSignService,
    SignaturePlacementService,
    SigningCredentialsService,
  ],
})
export class DocumentSigningModule {}
