import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateAccountNumber, validateBankBin } from './vietqr';

/** Only provider implemented: the payload is built in-process (src/payments/vietqr.ts). */
export const QR_PROVIDER_LOCAL_VIETQR = 'LOCAL_VIETQR';

export interface BankAccountConfig {
  bankBin: string;
  /** Display name shown to the customer, e.g. "Vietcombank". */
  bankName: string;
  /** String on purpose — leading zeros are significant. */
  accountNumber: string;
  /** Account holder exactly as the bank shows it (usually uppercase, no accents). */
  accountName: string;
}

export interface BankTransferConfigSnapshot extends BankAccountConfig {
  enabled: boolean;
  qrProvider: string;
}

export interface BankTransferConfigValidation {
  /** true when checkout may offer bank transfer (enabled + complete, valid account). */
  valid: boolean;
  errors: string[];
}

/**
 * Luxe Glow's receiving bank account for "Chuyển khoản ngân hàng (VietQR)" — env-driven, read on
 * every call like ZaloBotConfigService, so a Render env change + restart is all it takes. Nothing
 * here is secret, but the values are never hardcoded: each order keeps its own snapshot.
 */
@Injectable()
export class BankTransferConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): BankTransferConfigSnapshot {
    return {
      enabled: this.str('PAYMENT_BANK_ENABLED', 'false').toLowerCase() === 'true',
      qrProvider: this.str('PAYMENT_QR_PROVIDER', QR_PROVIDER_LOCAL_VIETQR).toUpperCase(),
      bankBin: this.str('PAYMENT_BANK_BIN', ''),
      bankName: this.str('PAYMENT_BANK_NAME', ''),
      accountNumber: this.str('PAYMENT_BANK_ACCOUNT_NUMBER', '').replace(/\s+/g, ''),
      accountName: this.str('PAYMENT_BANK_ACCOUNT_NAME', ''),
    };
  }

  validate(cfg: BankTransferConfigSnapshot = this.get()): BankTransferConfigValidation {
    const errors: string[] = [];
    if (!cfg.enabled) errors.push('PAYMENT_BANK_ENABLED=false — chuyển khoản ngân hàng đang tắt');
    if (cfg.qrProvider !== QR_PROVIDER_LOCAL_VIETQR) {
      errors.push(`PAYMENT_QR_PROVIDER=${cfg.qrProvider} không được hỗ trợ (chỉ ${QR_PROVIDER_LOCAL_VIETQR})`);
    }
    if (!cfg.bankBin) errors.push('PAYMENT_BANK_BIN chưa cấu hình');
    else {
      const err = validateBankBin(cfg.bankBin);
      if (err) errors.push(`PAYMENT_BANK_BIN: ${err}`);
    }
    if (!cfg.accountNumber) errors.push('PAYMENT_BANK_ACCOUNT_NUMBER chưa cấu hình');
    else {
      const err = validateAccountNumber(cfg.accountNumber);
      if (err) errors.push(`PAYMENT_BANK_ACCOUNT_NUMBER: ${err}`);
    }
    if (!cfg.accountName) errors.push('PAYMENT_BANK_ACCOUNT_NAME chưa cấu hình');
    if (!cfg.bankName) errors.push('PAYMENT_BANK_NAME chưa cấu hình');
    return { valid: errors.length === 0, errors };
  }

  /** The account new orders are told to pay into, or null when bank transfer is unavailable. */
  activeAccount(): BankAccountConfig | null {
    const cfg = this.get();
    if (!this.validate(cfg).valid) return null;
    return {
      bankBin: cfg.bankBin,
      bankName: cfg.bankName,
      accountNumber: cfg.accountNumber,
      accountName: cfg.accountName,
    };
  }

  private str(key: string, def: string): string {
    const v = this.config.get<string>(key);
    return v === undefined || v === null ? def : String(v).trim();
  }
}
