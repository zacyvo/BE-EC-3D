import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentAccountType } from '../orders/schemas/order.schema';
import { validateAccountNumber, validateBankBin } from './vietqr';

/** Only provider implemented: the payload is built in-process (src/payments/vietqr.ts). */
export const QR_PROVIDER_LOCAL_VIETQR = 'LOCAL_VIETQR';

/** Default receiving account when the customer doesn't choose (and when it's configured). */
export const DEFAULT_PAYMENT_ACCOUNT_TYPE = PaymentAccountType.PERSONAL;

/** Order in which accounts are offered / fallen back to. */
export const PAYMENT_ACCOUNT_TYPES: PaymentAccountType[] = [PaymentAccountType.PERSONAL, PaymentAccountType.BUSINESS];

/**
 * Env prefix per account. BUSINESS keeps the original `PAYMENT_BANK_*` names (Hộ kinh doanh
 * Luxe Glow, already configured on Render); PERSONAL is `PAYMENT_PERSONAL_BANK_*`.
 */
const ENV_PREFIX: Record<PaymentAccountType, string> = {
  [PaymentAccountType.PERSONAL]: 'PAYMENT_PERSONAL_BANK',
  [PaymentAccountType.BUSINESS]: 'PAYMENT_BANK',
};

export interface BankAccountConfig {
  bankBin: string;
  /** Display name shown to the customer, e.g. "Vietcombank". */
  bankName: string;
  /** String on purpose — leading zeros are significant. */
  accountNumber: string;
  /** Account holder exactly as the bank shows it (usually uppercase, no accents). */
  accountName: string;
  accountType: PaymentAccountType;
}

export interface BankTransferConfigSnapshot {
  enabled: boolean;
  qrProvider: string;
  accounts: Record<PaymentAccountType, BankAccountConfig>;
}

export interface BankTransferConfigValidation {
  /** true when checkout may offer bank transfer (enabled + at least one complete, valid account). */
  valid: boolean;
  errors: string[];
  /** Accounts that can receive payments right now, in PAYMENT_ACCOUNT_TYPES order. */
  availableAccountTypes: PaymentAccountType[];
}

/**
 * Luxe Glow's receiving bank accounts for "Chuyển khoản ngân hàng (VietQR)" — env-driven, read on
 * every call like ZaloBotConfigService, so a Render env change + restart is all it takes. Nothing
 * here is secret, but the values are never hardcoded: each order keeps its own snapshot.
 * Two accounts: PERSONAL (default) and BUSINESS (Hộ kinh doanh); either may be left unconfigured.
 */
@Injectable()
export class BankTransferConfigService {
  constructor(private readonly config: ConfigService) {}

  get(): BankTransferConfigSnapshot {
    const account = (type: PaymentAccountType): BankAccountConfig => {
      const p = ENV_PREFIX[type];
      return {
        bankBin: this.str(`${p}_BIN`, ''),
        bankName: this.str(`${p}_NAME`, ''),
        accountNumber: this.str(`${p}_ACCOUNT_NUMBER`, '').replace(/\s+/g, ''),
        accountName: this.str(`${p}_ACCOUNT_NAME`, ''),
        accountType: type,
      };
    };
    return {
      enabled: this.str('PAYMENT_BANK_ENABLED', 'false').toLowerCase() === 'true',
      qrProvider: this.str('PAYMENT_QR_PROVIDER', QR_PROVIDER_LOCAL_VIETQR).toUpperCase(),
      accounts: {
        [PaymentAccountType.PERSONAL]: account(PaymentAccountType.PERSONAL),
        [PaymentAccountType.BUSINESS]: account(PaymentAccountType.BUSINESS),
      },
    };
  }

  /** Problems of one account's values (empty = usable). */
  accountErrors(acc: BankAccountConfig): string[] {
    const p = ENV_PREFIX[acc.accountType];
    const errors: string[] = [];
    if (!acc.bankBin) errors.push(`${p}_BIN chưa cấu hình`);
    else {
      const err = validateBankBin(acc.bankBin);
      if (err) errors.push(`${p}_BIN: ${err}`);
    }
    if (!acc.accountNumber) errors.push(`${p}_ACCOUNT_NUMBER chưa cấu hình`);
    else {
      const err = validateAccountNumber(acc.accountNumber);
      if (err) errors.push(`${p}_ACCOUNT_NUMBER: ${err}`);
    }
    if (!acc.accountName) errors.push(`${p}_ACCOUNT_NAME chưa cấu hình`);
    if (!acc.bankName) errors.push(`${p}_NAME chưa cấu hình`);
    return errors;
  }

  validate(cfg: BankTransferConfigSnapshot = this.get()): BankTransferConfigValidation {
    const errors: string[] = [];
    if (!cfg.enabled) errors.push('PAYMENT_BANK_ENABLED=false — chuyển khoản ngân hàng đang tắt');
    if (cfg.qrProvider !== QR_PROVIDER_LOCAL_VIETQR) {
      errors.push(`PAYMENT_QR_PROVIDER=${cfg.qrProvider} không được hỗ trợ (chỉ ${QR_PROVIDER_LOCAL_VIETQR})`);
    }
    const accountErrors = PAYMENT_ACCOUNT_TYPES.map((t) => this.accountErrors(cfg.accounts[t]));
    const configured = PAYMENT_ACCOUNT_TYPES.filter((_, i) => accountErrors[i].length === 0);
    if (!configured.length) errors.push(...accountErrors.flat());
    const availableAccountTypes = errors.length ? [] : configured;
    return { valid: availableAccountTypes.length > 0, errors, availableAccountTypes };
  }

  /** Accounts the customer may choose from right now (empty when bank transfer is unavailable). */
  availableAccountTypes(): PaymentAccountType[] {
    return this.validate().availableAccountTypes;
  }

  /** PERSONAL when configured, otherwise the first available account; null when none. */
  defaultAccountType(): PaymentAccountType | null {
    const available = this.availableAccountTypes();
    return available.includes(DEFAULT_PAYMENT_ACCOUNT_TYPE) ? DEFAULT_PAYMENT_ACCOUNT_TYPE : available[0] ?? null;
  }

  /**
   * The account new payments are told to pay into, or null when that account (or bank transfer as a
   * whole) is unavailable. Without `type`, the default account.
   */
  activeAccount(type?: PaymentAccountType): BankAccountConfig | null {
    const cfg = this.get();
    const { availableAccountTypes } = this.validate(cfg);
    const chosen =
      type ??
      (availableAccountTypes.includes(DEFAULT_PAYMENT_ACCOUNT_TYPE) ? DEFAULT_PAYMENT_ACCOUNT_TYPE : availableAccountTypes[0]);
    if (!chosen || !availableAccountTypes.includes(chosen)) return null;
    return { ...cfg.accounts[chosen] };
  }

  private str(key: string, def: string): string {
    const v = this.config.get<string>(key);
    return v === undefined || v === null ? def : String(v).trim();
  }
}
