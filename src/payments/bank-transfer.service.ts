import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BankAccountSnapshot,
  Order,
  OrderDocument,
  OrderPayment,
  OrderStatus,
  PaymentHistoryAction,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
} from '../orders/schemas/order.schema';
import { BankTransferConfigService } from './bank-transfer.config';
import { buildVietQrPayload, decodeVietQrPayload, validateAmount } from './vietqr';

/** Transfer descriptions are "LG" + the end of the order id — short, alphanumeric, bank-safe.
 * 8 hex chars match the admin display code (#6A1B2C3D); longer suffixes are only used if a
 * reference ever collides (unique index), and stay within the 25-char VietQR limit. */
export const PAYMENT_REFERENCE_PREFIX = 'LG';
export const PAYMENT_REFERENCE_LENGTHS = [8, 16, 22];

export function paymentReferenceFor(orderId: string, length = PAYMENT_REFERENCE_LENGTHS[0]): string {
  return `${PAYMENT_REFERENCE_PREFIX}${orderId.slice(-length).toUpperCase()}`;
}

/** What the storefront needs to show the payment section of one order. */
export interface PaymentInstructions {
  orderId: string;
  /** Same "#XXXXXXXX" code the customer sees on the order page. */
  orderCode: string;
  orderStatus: OrderStatus;
  paymentMethod: PaymentMethod.BANK_TRANSFER;
  paymentStatus: PaymentStatus;
  verificationStatus: PaymentVerificationStatus;
  amount: number;
  currency: string;
  reference: string;
  bank: BankAccountSnapshot;
  /** true while the customer still has to pay (unpaid, not cancelled). */
  payable: boolean;
  /** VietQR payload to render — null when not payable or the payload failed its self-check. */
  qrPayload: string | null;
  qrError?: string;
  customerReportedAt?: Date;
  confirmedAt?: Date;
  refundAmount?: number;
  refundedAt?: Date;
}

/** Order statuses in which a bank-transfer order can still be paid / confirmed. */
export function isPaymentOpen(order: Pick<Order, 'status' | 'payment'>): boolean {
  return order.payment?.status === PaymentStatus.PENDING_PAYMENT && order.status !== OrderStatus.CANCELLED;
}

/**
 * VietQR bank-transfer instructions for an order (PaymentQrService in the spec): creates the
 * payment snapshot at checkout, keeps its amount in line with the order total while unpaid,
 * builds the QR payload, and records the customer's "Tôi đã chuyển khoản" claim. It NEVER marks
 * an order paid — that is PaymentConfirmationService, for authorized admins only.
 */
@Injectable()
export class BankTransferService {
  private readonly logger = new Logger(BankTransferService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly config: BankTransferConfigService,
  ) {}

  isAvailable(): boolean {
    return !!this.config.activeAccount();
  }

  /** Payment subdocument for a new checkout order. Throws (the order isn't created) when bank
   * transfer is off / misconfigured or the server-computed total can't be paid by QR. */
  buildInitialPayment(orderId: Types.ObjectId, total: number, referenceLength?: number): OrderPayment {
    const account = this.config.activeAccount();
    if (!account) {
      this.logger.warn(`Chuyển khoản không khả dụng: ${this.config.validate().errors.join('; ')}`);
      throw new BadRequestException('Phương thức chuyển khoản ngân hàng tạm thời không khả dụng — vui lòng chọn COD');
    }
    if (validateAmount(total)) {
      throw new BadRequestException('Số tiền đơn hàng không hợp lệ để thanh toán chuyển khoản');
    }
    const reference = paymentReferenceFor(orderId.toString(), referenceLength);
    return {
      status: PaymentStatus.PENDING_PAYMENT,
      reference,
      amount: total,
      currency: 'VND',
      bankAccount: { ...account },
      verificationStatus: PaymentVerificationStatus.NOT_REPORTED,
      history: [{ action: PaymentHistoryAction.INSTRUCTIONS_CREATED, at: new Date(), byType: 'system', amount: total }],
    };
  }

  /** Instructions for an order the caller already checked the customer may see. */
  async getInstructions(order: OrderDocument): Promise<PaymentInstructions> {
    this.assertBankTransfer(order);
    return this.toInstructions(await this.syncAmount(order));
  }

  /**
   * "Tôi đã chuyển khoản": records the claim (AWAITING_CONFIRMATION) — payment status stays
   * PENDING_PAYMENT. Idempotent: a repeated click returns the current state and queues nothing.
   * `outboxEvents` (owner Zalo notification) are queued in the same atomic update.
   */
  async reportTransfer(
    order: OrderDocument,
    actor: { userId: string; name?: string },
    outboxEvents: string[] = [],
  ): Promise<{ order: OrderDocument; reported: boolean }> {
    this.assertBankTransfer(order);
    const current = await this.syncAmount(order);
    if (current.payment!.verificationStatus !== PaymentVerificationStatus.NOT_REPORTED) {
      return { order: current, reported: false };
    }
    if (!isPaymentOpen(current)) {
      throw new BadRequestException(
        current.status === OrderStatus.CANCELLED ? 'Đơn hàng đã bị hủy' : 'Đơn hàng không còn chờ thanh toán',
      );
    }

    const now = new Date();
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: current._id,
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          'payment.status': PaymentStatus.PENDING_PAYMENT,
          'payment.verificationStatus': PaymentVerificationStatus.NOT_REPORTED,
          status: { $ne: OrderStatus.CANCELLED },
        },
        {
          $set: {
            'payment.verificationStatus': PaymentVerificationStatus.AWAITING_CONFIRMATION,
            'payment.customerReportedAt': now,
          },
          $push: {
            'payment.history': {
              action: PaymentHistoryAction.CUSTOMER_REPORTED,
              at: now,
              byType: 'user',
              by: actor.userId,
              ...(actor.name ? { byName: actor.name } : {}),
              amount: current.payment!.amount,
            },
          },
          $inc: { currentVersion: 1 },
          ...(outboxEvents.length ? { $addToSet: { pendingNotificationEvents: { $each: outboxEvents } } } : {}),
        },
        { new: true },
      )
      .exec();

    if (updated) return { order: updated, reported: true };
    // Lost a race (double click, admin confirmed / order cancelled meanwhile) — report what is true now.
    const latest = await this.orderModel.findById(current._id).exec();
    if (!latest) throw new BadRequestException('Không tìm thấy đơn hàng');
    if (latest.payment?.verificationStatus !== PaymentVerificationStatus.NOT_REPORTED) {
      return { order: latest, reported: false };
    }
    throw new BadRequestException('Đơn hàng vừa được cập nhật, vui lòng thử lại');
  }

  toInstructions(order: OrderDocument): PaymentInstructions {
    const payment = order.payment!;
    const payable = isPaymentOpen(order);
    let qrPayload: string | null = null;
    let qrError: string | undefined;
    if (payable) {
      try {
        const payload = buildVietQrPayload({
          bankBin: payment.bankAccount.bankBin,
          accountNumber: payment.bankAccount.accountNumber,
          amount: payment.amount,
          description: payment.reference,
        });
        // Self-check: never hand out a QR whose content differs from the order.
        const decoded = decodeVietQrPayload(payload);
        if (
          decoded.amount !== payment.amount ||
          decoded.description !== payment.reference ||
          decoded.accountNumber !== payment.bankAccount.accountNumber ||
          decoded.bankBin !== payment.bankAccount.bankBin
        ) {
          throw new Error('payload self-check mismatch');
        }
        qrPayload = payload;
      } catch (err) {
        this.logger.error(`Không tạo được VietQR cho đơn ${order._id}: ${(err as Error).message}`);
        qrError = 'Không tạo được mã QR — vui lòng chuyển khoản theo thông tin bên dưới';
      }
    }
    return {
      orderId: order._id.toString(),
      orderCode: `#${order._id.toString().slice(-8).toUpperCase()}`,
      orderStatus: order.status,
      paymentMethod: PaymentMethod.BANK_TRANSFER,
      paymentStatus: payment.status,
      verificationStatus: payment.verificationStatus,
      amount: payment.amount,
      currency: payment.currency,
      reference: payment.reference,
      bank: {
        bankBin: payment.bankAccount.bankBin,
        bankName: payment.bankAccount.bankName,
        accountNumber: payment.bankAccount.accountNumber,
        accountName: payment.bankAccount.accountName,
      },
      payable,
      qrPayload,
      ...(qrError ? { qrError } : {}),
      ...(payment.customerReportedAt ? { customerReportedAt: payment.customerReportedAt } : {}),
      ...(payment.confirmedAt ? { confirmedAt: payment.confirmedAt } : {}),
      ...(payment.refundAmount !== undefined ? { refundAmount: payment.refundAmount } : {}),
      ...(payment.refundedAt ? { refundedAt: payment.refundedAt } : {}),
    };
  }

  /**
   * While unpaid, the amount to transfer follows the order total (e.g. a VAT e-invoice request
   * adds 10%, a rejected one removes it). Guarded on both old values, so a concurrent change
   * simply leaves the next read to sync again. Paid / cancelled orders are never touched.
   */
  async syncAmount(order: OrderDocument): Promise<OrderDocument> {
    const payment = order.payment;
    if (!payment || !isPaymentOpen(order) || payment.amount === order.total) return order;
    if (validateAmount(order.total)) return order;

    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          total: order.total,
          'payment.status': PaymentStatus.PENDING_PAYMENT,
          'payment.amount': payment.amount,
        },
        {
          $set: { 'payment.amount': order.total },
          $push: {
            'payment.history': {
              action: PaymentHistoryAction.AMOUNT_UPDATED,
              at: new Date(),
              byType: 'system',
              amount: order.total,
              note: `Số tiền cần chuyển: ${payment.amount} → ${order.total}`,
            },
          },
        },
        { new: true },
      )
      .exec();
    if (updated) {
      this.logger.log(`Đơn ${order._id}: cập nhật số tiền chuyển khoản ${payment.amount} → ${order.total}`);
      return updated;
    }
    return (await this.orderModel.findById(order._id).exec()) ?? order;
  }

  private assertBankTransfer(order: OrderDocument): void {
    if (order.paymentMethod !== PaymentMethod.BANK_TRANSFER || !order.payment) {
      throw new BadRequestException('Đơn hàng này không sử dụng phương thức chuyển khoản ngân hàng');
    }
  }
}
