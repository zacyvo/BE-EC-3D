import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Order,
  OrderDocument,
  OrderStatus,
  PaymentConfirmationSource,
  PaymentHistoryAction,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
  RETURN_SETTLED_STATUSES,
} from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument } from '../orders/schemas/order-version.schema';
import { AuditService } from '../audit/audit.service';
import {
  PaymentEvent,
  PaymentEventAction,
  PaymentEventDocument,
  PaymentEventResult,
} from './schemas/payment-event.schema';
import { PAYMENT_REFERENCE_PREFIX } from './bank-transfer.service';

/** How an admin identified the order: payment reference (LG…), the admin display code
 * (#6A1B2C3D, last 8 chars of the id) or the full 24-char order id. */
export type OrderRef =
  | { kind: 'REFERENCE'; value: string }
  | { kind: 'DISPLAY_CODE'; value: string }
  | { kind: 'OBJECT_ID'; value: string };

export interface ConfirmActor {
  source: PaymentConfirmationSource;
  /** Staff id (CMS) or "zalo:<user id>" (Bot). */
  actorId: string;
  actorName?: string;
  senderZaloId?: string;
  providerMessageId?: string;
}

export interface ConfirmOptions {
  /** CMS: the amount the admin saw in the dialog — refuse if the order changed since. */
  expectedAmount?: number;
  /** Bot: the PROCESSING PaymentEvent row claimed for this webhook message. */
  eventId?: Types.ObjectId;
}

export type ConfirmOutcome =
  | { result: PaymentEventResult.SUCCESS; order: OrderDocument }
  | { result: PaymentEventResult.ALREADY_PAID; order: OrderDocument }
  | { result: PaymentEventResult.NOT_BANK_TRANSFER; order: OrderDocument }
  | { result: PaymentEventResult.INELIGIBLE; order: OrderDocument; reason: string }
  | { result: PaymentEventResult.AMOUNT_CHANGED; order: OrderDocument }
  | { result: PaymentEventResult.CONFLICT; order: OrderDocument }
  | { result: PaymentEventResult.NOT_FOUND; code: string }
  | { result: PaymentEventResult.AMBIGUOUS; code: string };

export type ResolveOutcome =
  | { order: OrderDocument }
  | { result: PaymentEventResult.NOT_FOUND | PaymentEventResult.AMBIGUOUS; code: string };

/** Order statuses that move to PROCESSING ("Đang chuẩn bị hàng") once the payment is confirmed —
 * an order already further along (shipped / delivered) keeps its status. */
export const AUTO_PREPARE_ON_PAYMENT_STATUSES = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

/** One row of the Zalo "Danh sách" answer. */
export interface PendingBankTransfer {
  orderId: string;
  reference: string;
  amount: number;
  customerName?: string;
  reportedAt?: Date;
  createdAt: Date;
}

/** The code to show back to an admin: the payment reference, else the display code. */
export function orderCodeOf(order: Pick<Order, '_id' | 'payment'>): string {
  return order.payment?.reference ?? `#${order._id.toString().slice(-8).toUpperCase()}`;
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}đ`;
}

/** Vietnamese explanation of a non-success outcome — shared by the Zalo reply and the CMS error. */
export function describeConfirmOutcome(outcome: ConfirmOutcome): string {
  switch (outcome.result) {
    case PaymentEventResult.SUCCESS:
      return `Đã xác nhận thanh toán đơn hàng ${orderCodeOf(outcome.order)}.`;
    case PaymentEventResult.NOT_FOUND:
      return `Không tìm thấy đơn hàng ${outcome.code}. Vui lòng kiểm tra lại mã đơn.`;
    case PaymentEventResult.AMBIGUOUS:
      return `Mã ${outcome.code} khớp với nhiều đơn hàng. Vui lòng gửi mã thanh toán đầy đủ (LG...) hoặc mã đơn 24 ký tự.`;
    case PaymentEventResult.NOT_BANK_TRANSFER:
      return 'Đơn hàng này không sử dụng phương thức chuyển khoản ngân hàng.';
    case PaymentEventResult.ALREADY_PAID:
      return `Đơn hàng ${orderCodeOf(outcome.order)} đã được xác nhận thanh toán trước đó.`;
    case PaymentEventResult.INELIGIBLE:
      return outcome.reason;
    case PaymentEventResult.AMOUNT_CHANGED:
      return `Số tiền của đơn hàng ${orderCodeOf(outcome.order)} vừa thay đổi thành ${formatVnd(outcome.order.total)}. Vui lòng kiểm tra lại trước khi xác nhận.`;
    case PaymentEventResult.CONFLICT:
      return `Đơn hàng ${orderCodeOf(outcome.order)} vừa được cập nhật, vui lòng thử lại.`;
  }
}

/**
 * The ONE place a bank-transfer order becomes PAID (PaymentConfirmationService in the spec).
 * Both the Zalo Bot command and the Admin CMS button call `confirm()`; callers authorize the
 * actor first. The transition PENDING_PAYMENT → PAID is a single conditional findOneAndUpdate,
 * so duplicates / concurrent confirmations produce exactly one success (and one history entry,
 * one version, one audit row). The same update moves a PENDING / CONFIRMED order to PROCESSING
 * ("Đang chuẩn bị hàng") — shop decision 2026-11-01; shipping / invoicing are never touched.
 */
@Injectable()
export class PaymentConfirmationService {
  private readonly logger = new Logger(PaymentConfirmationService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderVersion.name) private readonly versionModel: Model<OrderVersionDocument>,
    @InjectModel(PaymentEvent.name) private readonly eventModel: Model<PaymentEventDocument>,
    private readonly auditService: AuditService,
  ) {}

  async resolveOrder(ref: OrderRef): Promise<ResolveOutcome> {
    const shown = ref.kind === 'DISPLAY_CODE' ? `#${ref.value}` : ref.value;
    if (ref.kind === 'OBJECT_ID') {
      const order = Types.ObjectId.isValid(ref.value) ? await this.orderModel.findById(ref.value.toLowerCase()).exec() : null;
      return order ? { order } : { result: PaymentEventResult.NOT_FOUND, code: shown };
    }

    const reference = ref.kind === 'REFERENCE' ? ref.value : `${PAYMENT_REFERENCE_PREFIX}${ref.value}`;
    const byReference = await this.orderModel.findOne({ 'payment.reference': reference }).exec();
    if (byReference) return { order: byReference };

    // Not a bank-transfer reference: fall back to the admin display code (last 8 chars of the
    // id), so a COD order is answered with "not bank transfer" rather than "not found".
    const hex = ref.kind === 'DISPLAY_CODE' ? ref.value : ref.value.slice(PAYMENT_REFERENCE_PREFIX.length);
    if (!/^[0-9A-F]{8}$/.test(hex)) return { result: PaymentEventResult.NOT_FOUND, code: shown };
    const matches = await this.orderModel
      .find({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${hex.toLowerCase()}$` } } })
      .limit(2)
      .exec();
    if (matches.length === 1) return { order: matches[0] };
    return { result: matches.length ? PaymentEventResult.AMBIGUOUS : PaymentEventResult.NOT_FOUND, code: shown };
  }

  /** Validates the order and atomically marks it PAID. Always records a PaymentEvent. */
  async confirm(order: OrderDocument, actor: ConfirmActor, options: ConfirmOptions = {}): Promise<ConfirmOutcome> {
    const outcome = await this.tryConfirm(order, actor, options);
    await this.recordOutcome(outcome, actor, options.eventId, order);
    return outcome;
  }

  /** Admin CMS entry point (role already checked by the controller): same `confirm()` as the Bot. */
  async confirmByStaff(
    orderId: string,
    staff: { staffId: string; staffName?: string },
    expectedAmount?: number,
  ): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Không tìm thấy đơn hàng');
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const outcome = await this.confirm(
      order,
      { source: PaymentConfirmationSource.ADMIN_CMS, actorId: staff.staffId, actorName: staff.staffName },
      { expectedAmount },
    );
    if (outcome.result === PaymentEventResult.SUCCESS) return outcome.order;
    if (outcome.result === PaymentEventResult.ALREADY_PAID || outcome.result === PaymentEventResult.CONFLICT) {
      throw new ConflictException(describeConfirmOutcome(outcome));
    }
    throw new BadRequestException(describeConfirmOutcome(outcome));
  }

  /**
   * Admin CMS "Xác nhận đã hoàn tiền": records a refund the shop has ALREADY transferred by hand
   * (no money moves here). Only for a cancelled bank-transfer order whose payment is PAID — or still
   * PENDING_PAYMENT when the customer had reported a transfer before cancelling (money may have
   * arrived without ever being confirmed). One atomic, guarded update; one success per order.
   */
  async refundByStaff(
    orderId: string,
    staff: { staffId: string; staffName?: string },
    input: {
      amount: number;
      transferRef?: string;
      note?: string;
      refundAccount?: { bankName: string; accountNumber: string; accountHolder: string };
    },
  ): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Không tìm thấy đơn hàng');
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const code = orderCodeOf(order);
    const payment = order.payment;
    const record = (result: PaymentEventResult, errorReason?: string, amount?: number) =>
      this.eventModel
        .create({
          action: PaymentEventAction.REFUND_PAYMENT,
          source: PaymentConfirmationSource.ADMIN_CMS,
          result,
          orderId: order._id,
          orderCode: code,
          actorId: staff.staffId,
          ...(staff.staffName ? { actorName: staff.staffName } : {}),
          ...(payment ? { previousStatus: payment.status } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(result === PaymentEventResult.SUCCESS ? { newStatus: PaymentStatus.REFUNDED } : {}),
          ...(errorReason ? { errorReason } : {}),
        })
        .catch((err) => this.logger.error(`Không ghi được payment event hoàn tiền: ${(err as Error).message}`));
    const refuse = async (message: string, result = PaymentEventResult.INELIGIBLE, Ex = BadRequestException): Promise<never> => {
      await record(result, message, input.amount);
      throw new Ex(message);
    };

    if (order.paymentMethod !== PaymentMethod.BANK_TRANSFER || !payment) {
      return refuse('Đơn hàng này không sử dụng phương thức chuyển khoản ngân hàng.', PaymentEventResult.NOT_BANK_TRANSFER);
    }
    if (payment.status === PaymentStatus.REFUNDED) {
      return refuse(`Đơn hàng ${code} đã được ghi nhận hoàn tiền trước đó.`, PaymentEventResult.CONFLICT, ConflictException);
    }
    if (order.status !== OrderStatus.CANCELLED) {
      return refuse(`Đơn hàng ${code} chưa bị hủy — vui lòng hủy đơn trước khi ghi nhận hoàn tiền.`);
    }
    const reportedButUnconfirmed =
      payment.status === PaymentStatus.PENDING_PAYMENT &&
      payment.verificationStatus === PaymentVerificationStatus.AWAITING_CONFIRMATION;
    if (payment.status !== PaymentStatus.PAID && !reportedButUnconfirmed) {
      return refuse(`Đơn hàng ${code} chưa ghi nhận khoản thanh toán nào để hoàn.`);
    }
    // Paid: at most what was received. Reported-only: at most what the customer was asked to pay.
    const maxRefund = payment.status === PaymentStatus.PAID ? order.paidAmount : payment.amount;
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > maxRefund) {
      return refuse(`Số tiền hoàn phải là số nguyên từ 1 đến ${formatVnd(maxRefund)}.`);
    }

    const now = new Date();
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          status: OrderStatus.CANCELLED,
          'payment.status': payment.status,
          paidAmount: order.paidAmount,
        },
        {
          $set: {
            'payment.status': PaymentStatus.REFUNDED,
            'payment.refundedAt': now,
            'payment.refundedBy': staff.staffId,
            ...(staff.staffName ? { 'payment.refundedByName': staff.staffName } : {}),
            'payment.refundAmount': input.amount,
            ...(input.transferRef ? { 'payment.refundTransferRef': input.transferRef } : {}),
            ...(input.note ? { 'payment.refundNote': input.note } : {}),
            ...(input.refundAccount ? { 'payment.refundAccount': input.refundAccount } : {}),
            // paidAmount = what the shop still holds (0 after a full refund).
            paidAmount: Math.max(0, order.paidAmount - (payment.status === PaymentStatus.PAID ? input.amount : 0)),
          },
          $push: {
            'payment.history': {
              action: PaymentHistoryAction.REFUNDED,
              at: now,
              byType: 'staff',
              by: staff.staffId,
              ...(staff.staffName ? { byName: staff.staffName } : {}),
              source: PaymentConfirmationSource.ADMIN_CMS,
              amount: input.amount,
              ...(input.transferRef || input.note
                ? { note: [input.transferRef && `Mã GD: ${input.transferRef}`, input.note].filter(Boolean).join(' · ') }
                : {}),
            },
          },
          $inc: { currentVersion: 1 },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      return refuse(`Đơn hàng ${code} vừa được cập nhật, vui lòng tải lại và thử lại.`, PaymentEventResult.CONFLICT, ConflictException);
    }

    try {
      await this.versionModel.create({
        orderId: updated._id,
        versionNumber: updated.currentVersion,
        snapshot: updated.toObject(),
        changedBy: staff.staffId,
        changedByType: 'staff',
        changeNote: `Ghi nhận đã hoàn tiền ${formatVnd(input.amount)} (chuyển khoản)`,
      });
    } catch (err) {
      this.logger.error(`Không lưu được phiên bản đơn ${updated._id}: ${(err as Error).message}`);
    }
    await this.auditService.log({
      actorId: staff.staffId,
      actorType: 'staff',
      action: 'PAYMENT_REFUNDED',
      module: 'payments',
      targetId: updated._id.toString(),
      beforeData: { paymentStatus: payment.status, paidAmount: order.paidAmount },
      afterData: {
        paymentStatus: PaymentStatus.REFUNDED,
        paidAmount: updated.paidAmount,
        refundAmount: input.amount,
        ...(input.transferRef ? { transferRef: input.transferRef } : {}),
      },
    });
    await record(PaymentEventResult.SUCCESS, undefined, input.amount);
    this.logger.log(`Đơn ${code}: ghi nhận hoàn tiền ${input.amount} (${staff.staffId})`);
    return updated;
  }

  /** Records a Bot command that never reached an order (not found, ambiguous, …). */
  async recordUnresolved(
    outcome: Extract<ConfirmOutcome, { code: string }>,
    actor: ConfirmActor,
    eventId?: Types.ObjectId,
  ): Promise<void> {
    await this.recordOutcome(outcome, actor, eventId);
  }

  /**
   * Bot idempotency: claims a webhook message before anything else happens. Returns null when the
   * same message was already claimed (Zalo re-delivery / replay) — the caller then does nothing.
   */
  async claimBotMessage(
    dedupKey: string,
    actor: ConfirmActor,
    action: PaymentEventAction = PaymentEventAction.CONFIRM_PAYMENT,
  ): Promise<PaymentEventDocument | null> {
    try {
      return await this.eventModel.create({
        action,
        source: actor.source,
        result: PaymentEventResult.PROCESSING,
        actorId: actor.actorId,
        ...(actor.actorName ? { actorName: actor.actorName } : {}),
        ...(actor.senderZaloId ? { senderZaloId: actor.senderZaloId } : {}),
        ...(actor.providerMessageId ? { providerMessageId: actor.providerMessageId } : {}),
        dedupKey,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  async finishBotEvent(eventId: Types.ObjectId, fields: Partial<PaymentEvent>): Promise<void> {
    await this.eventModel.updateOne({ _id: eventId }, { $set: fields }).exec();
  }

  /** Unpaid, not-cancelled bank-transfer orders: customer-reported ones first (oldest report
   * first — they have waited longest), then the rest, newest first. */
  async listPendingBankTransfers(limit: number): Promise<{ items: PendingBankTransfer[]; total: number }> {
    const filter = {
      paymentMethod: PaymentMethod.BANK_TRANSFER,
      'payment.status': PaymentStatus.PENDING_PAYMENT,
      status: { $ne: OrderStatus.CANCELLED },
    };
    const select = { payment: 1, total: 1, shippingInfo: 1, createdAt: 1 };
    const [reported, others, total] = await Promise.all([
      this.orderModel
        .find({ ...filter, 'payment.verificationStatus': PaymentVerificationStatus.AWAITING_CONFIRMATION })
        .select(select)
        .sort({ 'payment.customerReportedAt': 1 })
        .limit(limit)
        .lean()
        .exec(),
      this.orderModel
        .find({ ...filter, 'payment.verificationStatus': { $ne: PaymentVerificationStatus.AWAITING_CONFIRMATION } })
        .select(select)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);
    const items = [...reported, ...others].slice(0, limit).map((o) => ({
      orderId: o._id.toString(),
      reference: o.payment!.reference,
      amount: o.total,
      ...(o.shippingInfo?.recipientName ? { customerName: o.shippingInfo.recipientName } : {}),
      ...(o.payment!.customerReportedAt ? { reportedAt: o.payment!.customerReportedAt } : {}),
      createdAt: (o as unknown as { createdAt: Date }).createdAt,
    }));
    return { items, total };
  }

  async eventsForOrder(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return [];
    return this.eventModel.find({ orderId: new Types.ObjectId(orderId) }).sort({ createdAt: -1 }).limit(100).lean().exec();
  }

  private async tryConfirm(order: OrderDocument, actor: ConfirmActor, options: ConfirmOptions): Promise<ConfirmOutcome> {
    const ineligible = this.checkEligibility(order);
    if (ineligible) return ineligible;
    if (options.expectedAmount !== undefined && options.expectedAmount !== order.total) {
      return { result: PaymentEventResult.AMOUNT_CHANGED, order };
    }

    const now = new Date();
    const amount = order.total;
    const nextStatus = AUTO_PREPARE_ON_PAYMENT_STATUSES.includes(order.status) ? OrderStatus.PROCESSING : order.status;
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          'payment.status': PaymentStatus.PENDING_PAYMENT,
          // Guarded on the status we decided from (also excludes CANCELLED, checked above) —
          // a concurrent status change makes this a CONFLICT instead of overwriting it.
          status: order.status,
          // The admin verified THIS amount — refuse if the total changed in between.
          total: amount,
        },
        {
          $set: {
            status: nextStatus,
            'payment.status': PaymentStatus.PAID,
            'payment.verificationStatus': PaymentVerificationStatus.CONFIRMED,
            'payment.amount': amount,
            'payment.confirmedAt': now,
            'payment.confirmedBy': actor.actorId,
            ...(actor.actorName ? { 'payment.confirmedByName': actor.actorName } : {}),
            'payment.confirmationSource': actor.source,
          },
          $max: { paidAmount: amount },
          $push: {
            'payment.history': {
              action: PaymentHistoryAction.CONFIRMED,
              at: now,
              byType: actor.source === PaymentConfirmationSource.ZALO_ADMIN_BOT ? 'zalo' : 'staff',
              by: actor.actorId,
              ...(actor.actorName ? { byName: actor.actorName } : {}),
              source: actor.source,
              amount,
              ...(nextStatus !== order.status ? { note: 'Đơn chuyển sang Đang chuẩn bị hàng' } : {}),
            },
          },
          $inc: { currentVersion: 1 },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      // Someone else changed the order first — classify against what is stored now.
      const latest = await this.orderModel.findById(order._id).exec();
      if (!latest) return { result: PaymentEventResult.NOT_FOUND, code: orderCodeOf(order) };
      const again = this.checkEligibility(latest);
      if (again) return again;
      if (latest.total !== amount) return { result: PaymentEventResult.AMOUNT_CHANGED, order: latest };
      return { result: PaymentEventResult.CONFLICT, order: latest };
    }

    const sourceLabel = actor.source === PaymentConfirmationSource.ZALO_ADMIN_BOT ? 'Zalo Bot' : 'Admin CMS';
    try {
      await this.versionModel.create({
        orderId: updated._id,
        versionNumber: updated.currentVersion,
        snapshot: updated.toObject(),
        changedBy: actor.actorId,
        changedByType: 'staff',
        changeNote:
          `Xác nhận đã thanh toán chuyển khoản (${sourceLabel})` +
          (nextStatus !== order.status ? ` — chuyển sang ${nextStatus}` : ''),
      });
    } catch (err) {
      // The payment IS confirmed at this point — a missing snapshot must not report a failure.
      this.logger.error(`Không lưu được phiên bản đơn ${updated._id}: ${(err as Error).message}`);
    }
    await this.auditService.log({
      actorId: actor.actorId,
      actorType: 'staff',
      action: 'PAYMENT_CONFIRMED',
      module: 'payments',
      targetId: updated._id.toString(),
      beforeData: {
        paymentStatus: PaymentStatus.PENDING_PAYMENT,
        verificationStatus: order.payment?.verificationStatus,
        orderStatus: order.status,
      },
      afterData: {
        paymentStatus: PaymentStatus.PAID,
        orderStatus: nextStatus,
        amount,
        reference: updated.payment?.reference,
        source: actor.source,
        ...(actor.senderZaloId ? { senderZaloId: actor.senderZaloId } : {}),
        ...(actor.providerMessageId ? { providerMessageId: actor.providerMessageId } : {}),
      },
    });
    this.logger.log(`Đơn ${orderCodeOf(updated)}: đã xác nhận thanh toán ${amount} (${sourceLabel}, ${actor.actorId})`);
    return { result: PaymentEventResult.SUCCESS, order: updated };
  }

  /** Why this order can't be confirmed, or null when it can. Checked before AND after the update. */
  private checkEligibility(order: OrderDocument): ConfirmOutcome | null {
    const code = orderCodeOf(order);
    if (order.paymentMethod !== PaymentMethod.BANK_TRANSFER || !order.payment) {
      return { result: PaymentEventResult.NOT_BANK_TRANSFER, order };
    }
    if (order.payment.status === PaymentStatus.PAID) return { result: PaymentEventResult.ALREADY_PAID, order };
    if (order.payment.status === PaymentStatus.REFUNDED) {
      return {
        result: PaymentEventResult.INELIGIBLE,
        order,
        reason: `Đơn hàng ${code} đã được hoàn tiền nên không thể xác nhận thanh toán.`,
      };
    }
    if (order.status === OrderStatus.CANCELLED) {
      return {
        result: PaymentEventResult.INELIGIBLE,
        order,
        reason: `Đơn hàng ${code} đã bị hủy nên không thể xác nhận thanh toán. Nếu khách đã chuyển khoản, vui lòng hoàn tiền thủ công.`,
      };
    }
    if (order.returnRequest && RETURN_SETTLED_STATUSES.includes(order.returnRequest.status)) {
      return {
        result: PaymentEventResult.INELIGIBLE,
        order,
        reason: `Đơn hàng ${code} đã trả hàng/hoàn tiền nên không thể xác nhận thanh toán.`,
      };
    }
    if (order.payment.status !== PaymentStatus.PENDING_PAYMENT) {
      return {
        result: PaymentEventResult.INELIGIBLE,
        order,
        reason: `Đơn hàng ${code} không ở trạng thái chờ thanh toán.`,
      };
    }
    return null;
  }

  private async recordOutcome(
    outcome: ConfirmOutcome,
    actor: ConfirmActor,
    eventId?: Types.ObjectId,
    original?: OrderDocument,
  ): Promise<void> {
    const order = 'order' in outcome ? outcome.order : original;
    const fields: Partial<PaymentEvent> = {
      result: outcome.result,
      ...(order ? { orderId: order._id, orderCode: orderCodeOf(order), amount: order.total } : {}),
      ...('code' in outcome ? { orderCode: outcome.code } : {}),
      ...(original?.payment ? { previousStatus: original.payment.status } : {}),
      ...(order?.payment ? { newStatus: order.payment.status } : {}),
      ...(outcome.result !== PaymentEventResult.SUCCESS ? { errorReason: describeConfirmOutcome(outcome) } : {}),
    };
    try {
      if (eventId) {
        await this.eventModel.updateOne({ _id: eventId }, { $set: fields }).exec();
      } else {
        await this.eventModel.create({
          action: PaymentEventAction.CONFIRM_PAYMENT,
          source: actor.source,
          actorId: actor.actorId,
          ...(actor.actorName ? { actorName: actor.actorName } : {}),
          ...fields,
        });
      }
    } catch (err) {
      // Never undo / fail a confirmation because its audit row couldn't be written.
      this.logger.error(`Không ghi được payment event (${outcome.result}): ${(err as Error).message}`);
    }
  }
}
