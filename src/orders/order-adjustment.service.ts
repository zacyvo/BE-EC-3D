import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AdjustmentSettlement,
  AdjustmentSettlementStatus,
  AdjustmentSettlementType,
  BankAccountSnapshot,
  EInvoiceRequestStatus,
  Order,
  OrderAdjustment,
  OrderAdjustmentSnapshot,
  OrderAdjustmentStatus,
  OrderDocument,
  OrderItem,
  OrderStatus,
  ORDER_ADJUSTABLE_STATUSES,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
} from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument } from './schemas/order-version.schema';
import {
  AcceptOrderAdjustmentDto,
  CompleteAdjustmentSettlementDto,
  ProposeOrderAdjustmentDto,
  RejectOrderAdjustmentDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';
import { computeOrderVat } from './einvoice-request.util';
import { ProductsService } from '../products/products.service';
import { resolveUnitPrice } from '../products/product-variant-price.util';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { OrderNotificationService } from '../zalo-bot/order-notification.service';
import { BankTransferService, PAYMENT_REFERENCE_PREFIX } from '../payments/bank-transfer.service';
import { validateAmount } from '../payments/vietqr';
import { MailService } from '../mail/mail.service';

/** What the storefront needs to pay the extra amount of an accepted adjustment by bank transfer. */
export interface AdjustmentPaymentInstructions {
  orderId: string;
  orderCode: string;
  adjustmentNumber: number;
  amount: number;
  reference: string;
  bank: BankAccountSnapshot;
  status: AdjustmentSettlementStatus;
  /** true while the extra amount is still to be paid (not confirmed, order not cancelled). */
  payable: boolean;
  qrPayload: string | null;
  qrError?: string;
  customerReportedAt?: Date;
  completedAt?: Date;
}

/** Order id suffix lengths tried for the extra-payment reference ("LG" + suffix + "T" + n): the
 * 8-char admin display code first, a longer one only if that ever collides (unique index). */
const EXTRA_REFERENCE_SUFFIX_LENGTHS = [8, 16];

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}đ`;
}

function displayCode(order: Pick<Order, '_id'>): string {
  return `#${order._id.toString().slice(-8).toUpperCase()}`;
}

/** Plain copy of the priced part of an order. */
function snapshotOf(order: OrderDocument): OrderAdjustmentSnapshot {
  const o = order.toObject() as Order;
  return {
    items: o.items,
    shippingInfo: o.shippingInfo,
    subtotal: o.subtotal,
    discountAmount: o.discountAmount ?? 0,
    shippingFee: o.shippingFee ?? 0,
    shippingDiscount: o.shippingDiscount ?? 0,
    total: o.total,
    ...(o.customerNote ? { customerNote: o.customerNote } : {}),
  };
}

/** Comparable form of a snapshot — used to refuse a proposal that changes nothing. */
function fingerprint(s: OrderAdjustmentSnapshot): string {
  const si = s.shippingInfo;
  return JSON.stringify({
    items: s.items.map((i) => [i.productId.toString(), i.quantity, i.unitPrice, i.color ?? '', i.size ?? '', i.note ?? '']),
    ship: [si.recipientName, si.phone, si.street, si.ward, si.district ?? '', si.city, si.note ?? ''],
    money: [s.subtotal, s.discountAmount, s.shippingFee, s.total],
    note: s.customerNote ?? '',
  });
}

const sameVariant = (a?: string, b?: string) => (a?.trim() || '') === (b?.trim() || '');

/**
 * "Điều chỉnh đơn hàng": a Super Admin fixes an order the customer got wrong (wrong item/variant,
 * missing item, wrong address…) — possibly already paid by bank transfer.
 *
 *  1. propose(): the new version is stored next to the order (`order.adjustment.after`); the
 *     order itself does NOT change. The customer is emailed (best effort).
 *  2. The customer accepts (→ the new version is applied in one guarded update) or rejects
 *     (→ nothing changes). The owner's Zalo Bot is notified either way.
 *  3. The difference is settled against what the customer had PAID (`paidAmount`), not the old
 *     total: less → the shop refunds the excess to the account the customer gave; more → the
 *     customer pays the rest by COD (collected on delivery) or by VietQR transfer (own reference
 *     "LG…T<n>", confirmed by an admin). Nothing moves money by itself — admins record it.
 */
@Injectable()
export class OrderAdjustmentService {
  private readonly logger = new Logger(OrderAdjustmentService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderVersion.name) private readonly versionModel: Model<OrderVersionDocument>,
    private readonly ordersService: OrdersService,
    private readonly productsService: ProductsService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly orderNotifications: OrderNotificationService,
    private readonly config: ConfigService,
    @Optional() private readonly bankTransfer?: BankTransferService,
    @Optional() private readonly mail?: MailService,
  ) {}

  // ─── Admin ────────────────────────────────────────────────────────────────

  async propose(
    orderId: string,
    staff: { staffId: string; staffName?: string },
    dto: ProposeOrderAdjustmentDto,
  ): Promise<OrderDocument> {
    const order = await this.loadOrder(orderId);
    this.assertAdjustable(order);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== order.currentVersion) {
      throw new ConflictException('Đơn hàng vừa được cập nhật — vui lòng tải lại trước khi điều chỉnh');
    }

    const before = snapshotOf(order);
    const after = await this.buildAfter(order, dto);
    if (fingerprint(before) === fingerprint(after)) {
      throw new BadRequestException('Không có thay đổi nào so với đơn hàng hiện tại');
    }
    const unpaidBankTransfer =
      order.paymentMethod === PaymentMethod.BANK_TRANSFER && order.payment?.status === PaymentStatus.PENDING_PAYMENT;
    if (unpaidBankTransfer && validateAmount(after.total)) {
      throw new BadRequestException('Tổng tiền mới phải lớn hơn 0 để khách thanh toán chuyển khoản');
    }

    const paid = order.paidAmount ?? 0;
    const adjustment: OrderAdjustment = {
      number: (order.adjustment?.number ?? 0) + 1,
      status: OrderAdjustmentStatus.PROPOSED,
      reason: dto.reason,
      proposedAt: new Date(),
      proposedBy: staff.staffId,
      ...(staff.staffName ? { proposedByName: staff.staffName } : {}),
      before,
      after,
      paidAmountAtProposal: paid,
      balance: paid > 0 ? after.total - paid : 0,
    };

    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: order._id, currentVersion: order.currentVersion, status: { $in: ORDER_ADJUSTABLE_STATUSES } },
        {
          $set: { adjustment },
          ...(order.adjustment ? { $push: { adjustmentHistory: order.adjustment } } : {}),
          $inc: { currentVersion: 1 },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException('Đơn hàng vừa được cập nhật — vui lòng tải lại và thử lại');

    await this.saveVersion(updated, staff.staffId, 'staff', `Đề xuất điều chỉnh đơn lần ${adjustment.number}: ${dto.reason}`);
    await this.auditService.log({
      actorId: staff.staffId,
      actorType: 'staff',
      action: 'PROPOSE_ORDER_ADJUSTMENT',
      module: 'orders',
      targetId: orderId,
      beforeData: before as unknown as Record<string, unknown>,
      afterData: { ...after, number: adjustment.number, balance: adjustment.balance, reason: dto.reason } as unknown as Record<string, unknown>,
    });
    this.emailCustomer(updated, adjustment).catch((err) =>
      this.logger.warn(`Không gửi được email điều chỉnh đơn ${displayCode(updated)}: ${(err as Error).message}`),
    );
    return updated;
  }

  /** Shop takes a pending proposal back (the order was never changed by it). */
  async withdraw(orderId: string, staffId: string, reason?: string): Promise<OrderDocument> {
    const order = await this.loadOrder(orderId);
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: order._id, 'adjustment.status': OrderAdjustmentStatus.PROPOSED },
        {
          $set: {
            'adjustment.status': OrderAdjustmentStatus.WITHDRAWN,
            'adjustment.withdrawnAt': new Date(),
            'adjustment.withdrawnBy': staffId,
            ...(reason ? { 'adjustment.withdrawReason': reason } : {}),
          },
          $inc: { currentVersion: 1 },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new BadRequestException('Đơn hàng không có đề xuất điều chỉnh nào đang chờ khách xác nhận');

    await this.saveVersion(updated, staffId, 'staff', `Thu hồi đề xuất điều chỉnh lần ${updated.adjustment!.number}`);
    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'WITHDRAW_ORDER_ADJUSTMENT',
      module: 'orders',
      targetId: orderId,
      afterData: { number: updated.adjustment!.number, reason },
    });
    return updated;
  }

  /** Records that the shop sent the refund / received the extra payment (no money moves here).
   * `paidAmount` keeps meaning "what the shop holds": − refund, + extra payment. */
  async completeSettlement(
    orderId: string,
    staff: { staffId: string; staffName?: string },
    dto: CompleteAdjustmentSettlementDto,
  ): Promise<OrderDocument> {
    const order = await this.loadOrder(orderId);
    const adj = order.adjustment;
    const st = adj?.settlement;
    if (!adj || adj.status !== OrderAdjustmentStatus.ACCEPTED || !st) {
      throw new BadRequestException('Đơn hàng không có khoản chênh lệch điều chỉnh nào cần xử lý');
    }
    if (st.status === AdjustmentSettlementStatus.COMPLETED) {
      throw new ConflictException('Khoản chênh lệch này đã được ghi nhận trước đó');
    }
    const paid = order.paidAmount ?? 0;
    const isRefund = st.type === AdjustmentSettlementType.REFUND;
    if (isRefund && paid < st.amount) {
      throw new BadRequestException(
        `Số tiền shop đang giữ (${formatVnd(paid)}) nhỏ hơn số tiền cần hoàn — đơn có thể đã được hoàn tiền theo luồng hủy đơn`,
      );
    }
    if (!isRefund && order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Đơn hàng đã bị hủy — không ghi nhận thu thêm');
    }

    const now = new Date();
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          'adjustment.number': adj.number,
          'adjustment.settlement.status': st.status,
          paidAmount: order.paidAmount,
        },
        {
          $set: {
            'adjustment.settlement.status': AdjustmentSettlementStatus.COMPLETED,
            'adjustment.settlement.completedAt': now,
            'adjustment.settlement.completedBy': staff.staffId,
            ...(staff.staffName ? { 'adjustment.settlement.completedByName': staff.staffName } : {}),
            ...(dto.transferRef ? { 'adjustment.settlement.transferRef': dto.transferRef } : {}),
            ...(dto.note ? { 'adjustment.settlement.note': dto.note } : {}),
            paidAmount: isRefund ? paid - st.amount : paid + st.amount,
          },
          $inc: { currentVersion: 1 },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException('Đơn hàng vừa được cập nhật — vui lòng tải lại và thử lại');

    const label = isRefund ? `Đã hoàn ${formatVnd(st.amount)} chênh lệch điều chỉnh` : `Đã nhận thêm ${formatVnd(st.amount)} chênh lệch điều chỉnh`;
    await this.saveVersion(updated, staff.staffId, 'staff', label);
    await this.auditService.log({
      actorId: staff.staffId,
      actorType: 'staff',
      action: isRefund ? 'ADJUSTMENT_REFUND_COMPLETED' : 'ADJUSTMENT_EXTRA_PAYMENT_RECEIVED',
      module: 'payments',
      targetId: orderId,
      beforeData: { paidAmount: paid, settlementStatus: st.status },
      afterData: { paidAmount: updated.paidAmount, amount: st.amount, transferRef: dto.transferRef, method: st.method },
    });
    return updated;
  }

  // ─── Customer ─────────────────────────────────────────────────────────────

  async accept(orderId: string, userId: string, dto: AcceptOrderAdjustmentDto): Promise<OrderDocument> {
    const order = await this.loadOrderForUser(orderId, userId);
    const adj = this.openProposal(order, dto.number);
    if (order.paidAmount !== adj.paidAmountAtProposal || order.total !== adj.before.total) {
      throw new BadRequestException('Đơn hàng vừa thay đổi — vui lòng chờ shop gửi lại đề xuất điều chỉnh');
    }

    const settlement = this.buildSettlement(adj, dto);
    const after = adj.after;
    const vatAmount =
      order.einvoiceRequest &&
      [EInvoiceRequestStatus.PENDING, EInvoiceRequestStatus.APPROVED].includes(order.einvoiceRequest.status)
        ? computeOrderVat(after).vatAmount
        : undefined;

    const outboxEvents = this.orderNotifications.adjustmentRespondedOutboxEvents(adj.number);
    const apply = (reference?: string) =>
      this.orderModel
        .findOneAndUpdate(
          {
            _id: order._id,
            userId: order.userId,
            'adjustment.number': adj.number,
            'adjustment.status': OrderAdjustmentStatus.PROPOSED,
            status: { $in: ORDER_ADJUSTABLE_STATUSES },
            total: adj.before.total,
            paidAmount: adj.paidAmountAtProposal,
          },
          {
            $set: {
              items: after.items,
              shippingInfo: after.shippingInfo,
              subtotal: after.subtotal,
              discountAmount: after.discountAmount,
              shippingFee: after.shippingFee,
              shippingDiscount: after.shippingDiscount,
              total: after.total,
              ...(after.customerNote ? { customerNote: after.customerNote } : {}),
              ...(vatAmount !== undefined ? { 'einvoiceRequest.vatAmount': vatAmount } : {}),
              'adjustment.status': OrderAdjustmentStatus.ACCEPTED,
              'adjustment.respondedAt': new Date(),
              ...(settlement ? { 'adjustment.settlement': { ...settlement, ...(reference ? { reference } : {}) } } : {}),
            },
            ...(after.customerNote ? {} : { $unset: { customerNote: 1 } }),
            $inc: { currentVersion: 1 },
            ...(outboxEvents.length ? { $addToSet: { pendingNotificationEvents: { $each: outboxEvents } } } : {}),
          },
          { new: true },
        )
        .exec();

    let updated: OrderDocument | null = null;
    if (settlement?.method === PaymentMethod.BANK_TRANSFER) {
      for (const [i, length] of EXTRA_REFERENCE_SUFFIX_LENGTHS.entries()) {
        const reference = `${PAYMENT_REFERENCE_PREFIX}${order._id.toString().slice(-length).toUpperCase()}T${adj.number}`;
        try {
          updated = await apply(reference);
          break;
        } catch (err) {
          const e = err as { code?: number; keyPattern?: Record<string, unknown> };
          const taken = e.code === 11000 && !!e.keyPattern?.['adjustment.settlement.reference'];
          if (!taken || i === EXTRA_REFERENCE_SUFFIX_LENGTHS.length - 1) throw err;
        }
      }
    } else {
      updated = await apply();
    }
    if (!updated) {
      const latest = await this.loadOrderForUser(orderId, userId);
      this.openProposal(latest, dto.number); // throws the specific reason when it's no longer open
      throw new BadRequestException('Đơn hàng vừa thay đổi — vui lòng tải lại trang');
    }

    // An unpaid bank-transfer order: the amount to transfer follows the new total.
    if (this.bankTransfer && updated.payment?.status === PaymentStatus.PENDING_PAYMENT) {
      updated = await this.bankTransfer.syncAmount(updated);
    }

    await this.saveVersion(updated, userId, 'user', `Khách hàng đồng ý điều chỉnh đơn lần ${adj.number}`);
    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'USER_ACCEPT_ORDER_ADJUSTMENT',
      module: 'orders',
      targetId: orderId,
      beforeData: { total: adj.before.total, paidAmount: adj.paidAmountAtProposal },
      afterData: {
        total: updated.total,
        number: adj.number,
        settlement: settlement ? { type: settlement.type, amount: settlement.amount, method: settlement.method } : null,
      },
    });
    this.orderNotifications.kick();
    return updated;
  }

  async reject(orderId: string, userId: string, dto: RejectOrderAdjustmentDto): Promise<OrderDocument> {
    const order = await this.loadOrderForUser(orderId, userId);
    const adj = this.openProposal(order, dto.number, { allowNonAdjustableStatus: true });
    const outboxEvents = this.orderNotifications.adjustmentRespondedOutboxEvents(adj.number);
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          userId: order.userId,
          'adjustment.number': adj.number,
          'adjustment.status': OrderAdjustmentStatus.PROPOSED,
        },
        {
          $set: {
            'adjustment.status': OrderAdjustmentStatus.REJECTED,
            'adjustment.respondedAt': new Date(),
            ...(dto.reason ? { 'adjustment.rejectReason': dto.reason } : {}),
          },
          $inc: { currentVersion: 1 },
          ...(outboxEvents.length ? { $addToSet: { pendingNotificationEvents: { $each: outboxEvents } } } : {}),
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new BadRequestException('Đề xuất điều chỉnh đã được xử lý — vui lòng tải lại trang');

    await this.saveVersion(updated, userId, 'user', `Khách hàng từ chối điều chỉnh đơn lần ${adj.number}`);
    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'USER_REJECT_ORDER_ADJUSTMENT',
      module: 'orders',
      targetId: orderId,
      afterData: { number: adj.number, reason: dto.reason },
    });
    this.orderNotifications.kick();
    return updated;
  }

  async getExtraPaymentForUser(orderId: string, userId: string): Promise<AdjustmentPaymentInstructions> {
    const order = await this.loadOrderForUser(orderId, userId);
    return this.toPaymentInstructions(order);
  }

  /** "Tôi đã chuyển khoản" for the extra amount — a claim only; an admin confirms it. Idempotent. */
  async reportExtraPayment(orderId: string, userId: string): Promise<AdjustmentPaymentInstructions & { alreadyReported: boolean }> {
    const order = await this.loadOrderForUser(orderId, userId);
    const current = this.toPaymentInstructions(order);
    if (current.status !== AdjustmentSettlementStatus.PENDING) return { ...current, alreadyReported: true };
    if (!current.payable) throw new BadRequestException('Không còn khoản cần chuyển khoản thêm cho đơn hàng này');

    const outboxEvents = this.orderNotifications.adjustmentPaymentReportedOutboxEvents(current.adjustmentNumber);
    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: order._id,
          userId: order.userId,
          'adjustment.number': current.adjustmentNumber,
          'adjustment.settlement.status': AdjustmentSettlementStatus.PENDING,
          'adjustment.settlement.method': PaymentMethod.BANK_TRANSFER,
        },
        {
          $set: {
            'adjustment.settlement.status': AdjustmentSettlementStatus.AWAITING_CONFIRMATION,
            'adjustment.settlement.customerReportedAt': new Date(),
          },
          $inc: { currentVersion: 1 },
          ...(outboxEvents.length ? { $addToSet: { pendingNotificationEvents: { $each: outboxEvents } } } : {}),
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      const latest = await this.loadOrderForUser(orderId, userId);
      return { ...this.toPaymentInstructions(latest), alreadyReported: true };
    }
    await this.saveVersion(updated, userId, 'user', 'Khách hàng báo đã chuyển khoản phần chênh lệch');
    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'USER_REPORT_ADJUSTMENT_TRANSFER',
      module: 'payments',
      targetId: orderId,
      afterData: { amount: current.amount, reference: current.reference },
    });
    this.orderNotifications.kick();
    return { ...this.toPaymentInstructions(updated), alreadyReported: false };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async loadOrder(orderId: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Không tìm thấy đơn hàng');
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return order;
  }

  private async loadOrderForUser(orderId: string, userId: string): Promise<OrderDocument> {
    const order = await this.loadOrder(orderId);
    if (order.userId.toString() !== userId) throw new ForbiddenException('Access denied');
    return order;
  }

  /** Why the shop can't adjust this order now (throws), or nothing. */
  private assertAdjustable(order: OrderDocument): void {
    if (!ORDER_ADJUSTABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException('Chỉ điều chỉnh được đơn chưa giao (Chờ xác nhận / Đã xác nhận / Đang chuẩn bị hàng)');
    }
    if (order.externalRef) {
      throw new BadRequestException('Đơn đồng bộ từ sàn thương mại điện tử — vui lòng điều chỉnh trên sàn');
    }
    if ((order.vatAmount ?? 0) > 0) {
      throw new BadRequestException('Đơn có VAT cộng thêm theo yêu cầu hoá đơn cũ — chưa hỗ trợ điều chỉnh');
    }
    if (order.einvoiceRequest?.status === EInvoiceRequestStatus.ISSUED) {
      throw new BadRequestException('Đơn đã xuất hoá đơn điện tử — cần xử lý hoá đơn điều chỉnh/thay thế trước khi sửa đơn');
    }
    if (
      order.payment?.status === PaymentStatus.PENDING_PAYMENT &&
      order.payment.verificationStatus === PaymentVerificationStatus.AWAITING_CONFIRMATION
    ) {
      throw new BadRequestException(
        'Khách đã báo chuyển khoản nhưng chưa được xác nhận — vui lòng kiểm tra và xác nhận thanh toán trước khi điều chỉnh',
      );
    }
    if (order.adjustment?.status === OrderAdjustmentStatus.PROPOSED) {
      throw new BadRequestException('Đơn đang có đề xuất điều chỉnh chờ khách xác nhận — vui lòng thu hồi đề xuất đó trước');
    }
    const st = order.adjustment?.settlement;
    if (st && st.status !== AdjustmentSettlementStatus.COMPLETED) {
      throw new BadRequestException(
        'Lần điều chỉnh trước còn khoản hoàn tiền/thu thêm chưa hoàn tất — vui lòng ghi nhận khoản đó trước',
      );
    }
  }

  /** The new version of the order from the admin's input — prices / names snapshotted the same way
   * as at checkout, so the customer sees exactly what will be applied. */
  private async buildAfter(order: OrderDocument, dto: ProposeOrderAdjustmentDto): Promise<OrderAdjustmentSnapshot> {
    const items: OrderItem[] = [];
    for (const input of dto.items) {
      const existing = order.items.find(
        (i) => i.productId.toString() === input.productId && sameVariant(i.color, input.color) && sameVariant(i.size, input.size),
      );
      let product: Awaited<ReturnType<ProductsService['findById']>> | null = null;
      try {
        product = await this.productsService.findById(input.productId, false);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }

      if (!product) {
        // Product removed from the catalog since checkout: the line can only be kept as it was.
        if (!existing) throw new BadRequestException('Sản phẩm không tồn tại hoặc đã bị xoá');
        const unitPrice = Math.round(input.unitPrice ?? existing.unitPrice);
        items.push({
          productId: existing.productId,
          productName: existing.productName,
          productImage: existing.productImage,
          productSlug: existing.productSlug,
          quantity: input.quantity,
          unitPrice,
          subtotal: unitPrice * input.quantity,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          ...(existing.color ? { color: existing.color } : {}),
          ...(existing.size ? { size: existing.size } : {}),
        });
        continue;
      }

      const variant = this.ordersService.resolveVariant(product, input.color, input.size);
      const increased = !existing || input.quantity > existing.quantity;
      if (increased && product.stock < input.quantity) {
        throw new BadRequestException(`Không đủ hàng: ${product.name} (còn ${product.stock})`);
      }
      const unitPrice = Math.round(input.unitPrice ?? resolveUnitPrice(product, variant.color, variant.size));
      items.push({
        productId: new Types.ObjectId(input.productId),
        productName: product.name,
        productImage: variant.image,
        productSlug: product.slug,
        quantity: input.quantity,
        unitPrice,
        subtotal: unitPrice * input.quantity,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        ...(variant.color ? { color: variant.color } : {}),
        ...(variant.size ? { size: variant.size } : {}),
      });
    }

    const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
    const discountAmount = Math.min(Math.round(dto.discountAmount ?? order.discountAmount ?? 0), subtotal);
    const shippingFee = Math.round(dto.shippingFee ?? order.shippingFee ?? 0);
    // A changed fee is the admin's own number — the free-shipping coupon no longer explains it.
    const shippingDiscount = shippingFee === (order.shippingFee ?? 0) ? order.shippingDiscount ?? 0 : 0;
    const shippingInfo = dto.shippingInfo
      ? this.ordersService.resolveShippingInfo(dto.shippingInfo)
      : (order.toObject() as Order).shippingInfo;
    const customerNote = dto.customerNote !== undefined ? dto.customerNote.trim() : order.customerNote;

    return {
      items,
      shippingInfo: shippingInfo as OrderAdjustmentSnapshot['shippingInfo'],
      subtotal,
      discountAmount,
      shippingFee,
      shippingDiscount,
      total: subtotal - discountAmount + shippingFee,
      ...(customerNote ? { customerNote } : {}),
    };
  }

  /** The open proposal with this number, or the reason it can't be answered (throws). */
  private openProposal(
    order: OrderDocument,
    number: number,
    { allowNonAdjustableStatus = false }: { allowNonAdjustableStatus?: boolean } = {},
  ): OrderAdjustment {
    const adj = order.adjustment;
    if (!adj || adj.number !== number) throw new BadRequestException('Đề xuất điều chỉnh không còn hiệu lực — vui lòng tải lại trang');
    if (adj.status === OrderAdjustmentStatus.ACCEPTED) throw new BadRequestException('Bạn đã đồng ý đề xuất điều chỉnh này');
    if (adj.status === OrderAdjustmentStatus.REJECTED) throw new BadRequestException('Bạn đã từ chối đề xuất điều chỉnh này');
    if (adj.status === OrderAdjustmentStatus.WITHDRAWN) throw new BadRequestException('Shop đã thu hồi đề xuất điều chỉnh này');
    if (!allowNonAdjustableStatus && !ORDER_ADJUSTABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException('Đơn hàng không còn điều chỉnh được ở trạng thái hiện tại — vui lòng liên hệ shop');
    }
    return adj;
  }

  private buildSettlement(
    adj: OrderAdjustment,
    dto: AcceptOrderAdjustmentDto,
  ): Omit<AdjustmentSettlement, 'reference'> | null {
    if (adj.balance < 0) {
      if (!dto.refundAccount) {
        throw new BadRequestException('Vui lòng nhập tài khoản ngân hàng để nhận lại tiền chênh lệch');
      }
      return {
        type: AdjustmentSettlementType.REFUND,
        amount: -adj.balance,
        status: AdjustmentSettlementStatus.PENDING,
        refundAccount: dto.refundAccount,
      };
    }
    if (adj.balance > 0) {
      if (!dto.extraPaymentMethod) {
        throw new BadRequestException('Vui lòng chọn hình thức thanh toán phần còn lại (COD hoặc chuyển khoản)');
      }
      if (dto.extraPaymentMethod === PaymentMethod.BANK_TRANSFER) {
        const bank = this.bankTransfer?.activeAccountSnapshot();
        if (!bank) {
          throw new BadRequestException('Chuyển khoản ngân hàng tạm thời không khả dụng — vui lòng chọn COD');
        }
        if (validateAmount(adj.balance)) throw new BadRequestException('Số tiền cần thanh toán thêm không hợp lệ');
        return {
          type: AdjustmentSettlementType.EXTRA_PAYMENT,
          amount: adj.balance,
          status: AdjustmentSettlementStatus.PENDING,
          method: PaymentMethod.BANK_TRANSFER,
          bankAccount: bank,
        };
      }
      return {
        type: AdjustmentSettlementType.EXTRA_PAYMENT,
        amount: adj.balance,
        status: AdjustmentSettlementStatus.PENDING,
        method: PaymentMethod.COD,
      };
    }
    return null;
  }

  private toPaymentInstructions(order: OrderDocument): AdjustmentPaymentInstructions {
    const adj = order.adjustment;
    const st = adj?.settlement;
    if (
      !adj ||
      !st ||
      st.type !== AdjustmentSettlementType.EXTRA_PAYMENT ||
      st.method !== PaymentMethod.BANK_TRANSFER ||
      !st.reference ||
      !st.bankAccount
    ) {
      throw new BadRequestException('Đơn hàng không có khoản chuyển khoản thêm nào');
    }
    const payable = st.status !== AdjustmentSettlementStatus.COMPLETED && order.status !== OrderStatus.CANCELLED;
    const qr = payable && this.bankTransfer
      ? this.bankTransfer.buildQr(st.bankAccount, st.amount, st.reference, order._id.toString())
      : { qrPayload: null as string | null, qrError: undefined };
    return {
      orderId: order._id.toString(),
      orderCode: displayCode(order),
      adjustmentNumber: adj.number,
      amount: st.amount,
      reference: st.reference,
      bank: {
        bankBin: st.bankAccount.bankBin,
        bankName: st.bankAccount.bankName,
        accountNumber: st.bankAccount.accountNumber,
        accountName: st.bankAccount.accountName,
      },
      status: st.status,
      payable,
      qrPayload: qr.qrPayload,
      ...(qr.qrError ? { qrError: qr.qrError } : {}),
      ...(st.customerReportedAt ? { customerReportedAt: st.customerReportedAt } : {}),
      ...(st.completedAt ? { completedAt: st.completedAt } : {}),
    };
  }

  private async emailCustomer(order: OrderDocument, adj: OrderAdjustment): Promise<void> {
    if (!this.mail) return;
    const user = await this.usersService.findById(order.userId.toString());
    if (!user?.email || user.isGuest) return;
    const base = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000').replace(/\/+$/, '');
    await this.mail.sendOrderAdjustmentProposed(user.email, {
      customerName: user.name || order.shippingInfo.recipientName,
      orderCode: displayCode(order),
      reason: adj.reason,
      beforeTotal: adj.before.total,
      afterTotal: adj.after.total,
      balance: adj.balance,
      orderUrl: `${base}/orders/${order._id.toString()}`,
    });
  }

  private async saveVersion(order: OrderDocument, changedBy: string, changedByType: 'user' | 'staff', changeNote: string) {
    try {
      await this.versionModel.create({
        orderId: order._id,
        versionNumber: order.currentVersion,
        snapshot: order.toObject(),
        changedBy,
        changedByType,
        changeNote,
      });
    } catch (err) {
      // The change IS saved at this point — a missing snapshot must not report a failure.
      this.logger.error(`Không lưu được phiên bản đơn ${order._id}: ${(err as Error).message}`);
    }
  }
}
