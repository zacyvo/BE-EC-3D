import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, PipelineStage, Types, UpdateQuery } from 'mongoose';
import {
  Order,
  OrderDocument,
  OrderStatus,
  ReturnHistoryEntry,
  ReturnItem,
  ReturnStatus,
} from '../orders/schemas/order.schema';
import { OrderVersion, OrderVersionDocument } from '../orders/schemas/order-version.schema';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { OrderNotificationService } from '../zalo-bot/order-notification.service';
import {
  ApproveReturnDto,
  CompleteRefundDto,
  CreateReturnRequestDto,
  InspectReturnDto,
  ReceiveReturnDto,
  RejectReturnDto,
  ReturnShipmentDto,
} from './dto/order-return.dto';
import {
  OPEN_RETURN_STATUSES,
  RECEIVABLE_RETURN_STATUSES,
  RETURN_WINDOW_DAYS,
  RETURN_WINDOW_MS,
  USER_CANCELLABLE_RETURN_STATUSES,
  USER_SHIPPABLE_RETURN_STATUSES,
} from './order-return.constants';

export interface ReturnEligibility {
  eligible: boolean;
  /** Why the customer can't request a return (absent when eligible). */
  reason?: string;
  deliveredAt?: Date;
  /** Last moment a request is accepted (deliveredAt + RETURN_WINDOW_DAYS). */
  deadline?: Date;
  /** A refund account is required (the order has a recorded payment). */
  requiresRefundAccount: boolean;
}

type Actor = { id: string; type: 'user' | 'staff' };

/** Suggested refund for the returned goods: their price minus their prorated share of the
 * order discount, never more than what the customer actually paid. Shipping isn't included. */
export function estimateReturnRefund(
  order: Pick<Order, 'subtotal' | 'discountAmount' | 'paidAmount'>,
  items: Pick<ReturnItem, 'unitPrice' | 'quantity'>[],
): number {
  const goods = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const discount = order.subtotal > 0 ? Math.round(((order.discountAmount || 0) * goods) / order.subtotal) : 0;
  return Math.max(0, Math.min(goods - discount, order.paidAmount || 0));
}

/**
 * Return/refund flow for delivered website orders (modelled on Shopee "Trả hàng/Hoàn tiền"):
 *
 *   customer: request (≤ 7 days after delivery) ─▶ REQUESTED
 *   shop:     approve ─▶ APPROVED            | reject ─▶ REJECTED
 *   customer: enter return tracking ─▶ SHIPPING_BACK   (or withdraw ─▶ CANCELLED before that)
 *   shop:     parcel arrived ─▶ RECEIVED
 *   shop:     inspection passed ─▶ REFUNDING (or COMPLETED when nothing to refund)
 *             inspection failed ─▶ REJECTED (goods are sent back to the customer)
 *   shop:     refund transferred ─▶ COMPLETED
 *
 * The request lives on the order (`Order.returnRequest`), one per order; Order.status stays
 * DELIVERED. Every transition is a single findOneAndUpdate guarded by the expected current
 * status, so two staff members (or a customer and the shop) can't both win a race.
 */
@Injectable()
export class OrderReturnsService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderVersion.name) private readonly orderVersionModel: Model<OrderVersionDocument>,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly orderNotifications: OrderNotificationService,
  ) {}

  // ─── Customer ────────────────────────────────────────────────────────────

  private async findOwnOrder(orderId: string, userId: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Order not found');
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId.toString() !== userId) throw new ForbiddenException('Access denied');
    return order;
  }

  /** Orders delivered before `deliveredAt` existed: the first version snapshot that shows
   * DELIVERED is when it happened. */
  private async resolveDeliveredAt(order: OrderDocument): Promise<Date | undefined> {
    if (order.deliveredAt) return order.deliveredAt;
    const version = await this.orderVersionModel
      .findOne({ orderId: order._id, 'snapshot.status': OrderStatus.DELIVERED })
      .sort({ versionNumber: 1 })
      .lean()
      .exec();
    return version?.createdAt;
  }

  private async eligibilityOf(order: OrderDocument, now = new Date()): Promise<ReturnEligibility> {
    const requiresRefundAccount = (order.paidAmount || 0) > 0;
    const no = (reason: string, extra: Partial<ReturnEligibility> = {}): ReturnEligibility => ({
      eligible: false,
      reason,
      requiresRefundAccount,
      ...extra,
    });
    if (order.returnRequest) return no('Đơn hàng đã có yêu cầu trả hàng');
    if (order.externalRef) {
      return no(`Đơn đặt trên ${order.externalRef.channel} — vui lòng yêu cầu trả hàng trên ứng dụng ${order.externalRef.channel}`);
    }
    if (order.status !== OrderStatus.DELIVERED) return no('Chỉ có thể trả hàng khi đơn đã giao thành công');
    const deliveredAt = await this.resolveDeliveredAt(order);
    if (!deliveredAt) return no('Không xác định được ngày giao hàng — vui lòng liên hệ shop');
    const deadline = new Date(deliveredAt.getTime() + RETURN_WINDOW_MS);
    if (now > deadline) {
      return no(`Đã quá hạn ${RETURN_WINDOW_DAYS} ngày kể từ ngày nhận hàng`, { deliveredAt, deadline });
    }
    return { eligible: true, deliveredAt, deadline, requiresRefundAccount };
  }

  async getEligibility(orderId: string, userId: string): Promise<ReturnEligibility> {
    return this.eligibilityOf(await this.findOwnOrder(orderId, userId));
  }

  async createRequest(orderId: string, userId: string, dto: CreateReturnRequestDto): Promise<OrderDocument> {
    const order = await this.findOwnOrder(orderId, userId);
    const eligibility = await this.eligibilityOf(order);
    if (!eligibility.eligible) throw new BadRequestException(eligibility.reason);

    const seen = new Set<number>();
    const items: ReturnItem[] = dto.items.map(({ itemIndex, quantity }) => {
      const line = order.items[itemIndex];
      if (!line) throw new BadRequestException('Sản phẩm trả không thuộc đơn hàng');
      if (seen.has(itemIndex)) throw new BadRequestException('Sản phẩm trả bị trùng');
      seen.add(itemIndex);
      if (quantity > line.quantity) {
        throw new BadRequestException(`Số lượng trả của "${line.productName}" vượt quá số lượng đã mua (${line.quantity})`);
      }
      return {
        itemIndex,
        productName: line.productName,
        productImage: line.productImage,
        ...(line.color ? { color: line.color } : {}),
        ...(line.size ? { size: line.size } : {}),
        quantity,
        unitPrice: line.unitPrice,
      };
    });
    if (eligibility.requiresRefundAccount && !dto.refundAccount) {
      throw new BadRequestException('Vui lòng nhập tài khoản ngân hàng để nhận tiền hoàn');
    }

    const user = await this.usersService.findById(userId);
    const now = new Date();
    const outboxEvents = this.orderNotifications.returnRequestedOutboxEvents();
    const updated = await this.orderModel
      .findOneAndUpdate(
        // Guard: still delivered and no concurrent request slipped in.
        { _id: order._id, userId: order.userId, status: OrderStatus.DELIVERED, returnRequest: { $exists: false } },
        {
          $set: {
            // Persist the resolved delivery date so the window never moves.
            ...(order.deliveredAt ? {} : { deliveredAt: eligibility.deliveredAt }),
            returnRequest: {
              status: ReturnStatus.REQUESTED,
              items,
              reason: dto.reason,
              description: dto.description.trim(),
              images: dto.images,
              ...(dto.refundAccount
                ? {
                    refundAccount: {
                      bankName: dto.refundAccount.bankName.trim(),
                      accountNumber: dto.refundAccount.accountNumber.trim(),
                      accountHolder: dto.refundAccount.accountHolder.trim().toUpperCase(),
                    },
                  }
                : {}),
              requestedAt: now,
              requestedByName: user?.name || order.shippingInfo?.recipientName,
              estimatedRefund: estimateReturnRefund(order, items),
              history: [{ status: ReturnStatus.REQUESTED, at: now, byType: 'user', by: userId }],
            },
          },
          $inc: { currentVersion: 1 },
          ...(outboxEvents.length ? { $addToSet: { pendingNotificationEvents: { $each: outboxEvents } } } : {}),
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new BadRequestException('Đơn hàng không còn đủ điều kiện trả hàng — vui lòng tải lại trang');

    await this.afterTransition(updated, { id: userId, type: 'user' }, 'USER_REQUEST_RETURN', 'Khách hàng yêu cầu trả hàng/hoàn tiền');
    // Non-blocking: a Zalo failure can't affect the request.
    this.orderNotifications.kick();
    return updated;
  }

  async cancelRequest(orderId: string, userId: string): Promise<OrderDocument> {
    const order = await this.findOwnOrder(orderId, userId);
    return this.transition(order, USER_CANCELLABLE_RETURN_STATUSES, ReturnStatus.CANCELLED, { id: userId, type: 'user' }, {
      action: 'USER_CANCEL_RETURN',
      changeNote: 'Khách hàng hủy yêu cầu trả hàng',
      note: 'Khách hàng hủy yêu cầu',
    });
  }

  async submitShipment(orderId: string, userId: string, dto: ReturnShipmentDto): Promise<OrderDocument> {
    const order = await this.findOwnOrder(orderId, userId);
    const shipment = {
      ...(dto.carrierName?.trim() ? { carrierName: dto.carrierName.trim() } : {}),
      trackingCode: dto.trackingCode.trim(),
      shippedAt: new Date(),
    };
    return this.transition(order, USER_SHIPPABLE_RETURN_STATUSES, ReturnStatus.SHIPPING_BACK, { id: userId, type: 'user' }, {
      action: 'USER_SHIP_RETURN',
      changeNote: 'Khách hàng gửi hàng trả',
      note: `Mã vận đơn: ${shipment.trackingCode}${shipment.carrierName ? ` (${shipment.carrierName})` : ''}`,
      set: { 'returnRequest.shipment': shipment },
    });
  }

  // ─── Shop ────────────────────────────────────────────────────────────────

  private async findOrderForStaff(orderId: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Order not found');
    const order = await this.orderModel.findById(orderId).exec();
    if (!order?.returnRequest) throw new NotFoundException('Không tìm thấy yêu cầu trả hàng');
    return order;
  }

  async approve(orderId: string, staffId: string, dto: ApproveReturnDto): Promise<OrderDocument> {
    const order = await this.findOrderForStaff(orderId);
    const shopNote = dto.shopNote?.trim();
    return this.transition(order, [ReturnStatus.REQUESTED], ReturnStatus.APPROVED, { id: staffId, type: 'staff' }, {
      action: 'APPROVE_RETURN',
      changeNote: 'Shop chấp nhận yêu cầu trả hàng',
      note: shopNote,
      set: shopNote ? { 'returnRequest.shopNote': shopNote } : {},
    });
  }

  async reject(orderId: string, staffId: string, dto: RejectReturnDto): Promise<OrderDocument> {
    const order = await this.findOrderForStaff(orderId);
    const reason = dto.reason.trim();
    return this.transition(order, [ReturnStatus.REQUESTED], ReturnStatus.REJECTED, { id: staffId, type: 'staff' }, {
      action: 'REJECT_RETURN',
      changeNote: 'Shop từ chối yêu cầu trả hàng',
      note: reason,
      set: { 'returnRequest.rejectReason': reason, 'returnRequest.rejectedAt': 'REQUEST' },
    });
  }

  async markReceived(orderId: string, staffId: string, dto: ReceiveReturnDto): Promise<OrderDocument> {
    const order = await this.findOrderForStaff(orderId);
    return this.transition(order, RECEIVABLE_RETURN_STATUSES, ReturnStatus.RECEIVED, { id: staffId, type: 'staff' }, {
      action: 'RECEIVE_RETURN',
      changeNote: 'Shop đã nhận hàng trả',
      note: dto.note?.trim(),
      set: { 'returnRequest.receivedAt': new Date() },
    });
  }

  async inspect(orderId: string, staffId: string, dto: InspectReturnDto): Promise<OrderDocument> {
    const order = await this.findOrderForStaff(orderId);
    const note = dto.note?.trim();
    const actor: Actor = { id: staffId, type: 'staff' };

    if (!dto.passed) {
      if (!note) throw new BadRequestException('Vui lòng ghi rõ lý do hàng trả không đạt');
      return this.transition(order, [ReturnStatus.RECEIVED], ReturnStatus.REJECTED, actor, {
        action: 'INSPECT_RETURN_FAILED',
        changeNote: 'Hàng trả không đạt kiểm tra',
        note,
        set: { 'returnRequest.inspectionNote': note, 'returnRequest.rejectReason': note, 'returnRequest.rejectedAt': 'INSPECTION' },
      });
    }

    const request = order.returnRequest!;
    const refundAmount = Math.round(dto.refundAmount ?? request.estimatedRefund);
    const returnShippingRefund = Math.round(dto.returnShippingRefund ?? 0);
    const paid = order.paidAmount || 0;
    if (refundAmount > paid) {
      throw new BadRequestException(`Tiền hoàn hàng không được vượt quá số tiền khách đã thanh toán (${paid.toLocaleString('vi-VN')}đ)`);
    }
    const goodsValue = request.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    if (refundAmount > goodsValue) {
      throw new BadRequestException(`Tiền hoàn hàng không được vượt quá giá trị hàng trả (${goodsValue.toLocaleString('vi-VN')}đ)`);
    }
    const totalRefund = refundAmount + returnShippingRefund;
    // "Hoàn tiền (nếu có)": nothing to pay back → the return is done right away.
    const next = totalRefund > 0 ? ReturnStatus.REFUNDING : ReturnStatus.COMPLETED;
    return this.transition(order, [ReturnStatus.RECEIVED], next, actor, {
      action: 'INSPECT_RETURN_PASSED',
      changeNote: totalRefund > 0 ? 'Hàng trả đạt — chờ hoàn tiền' : 'Hàng trả đạt — không phát sinh hoàn tiền',
      note: [note, `Hoàn tiền: ${totalRefund.toLocaleString('vi-VN')}đ`].filter(Boolean).join(' — '),
      set: {
        ...(note ? { 'returnRequest.inspectionNote': note } : {}),
        'returnRequest.refundAmount': refundAmount,
        'returnRequest.returnShippingRefund': returnShippingRefund,
      },
    });
  }

  async completeRefund(orderId: string, staffId: string, dto: CompleteRefundDto): Promise<OrderDocument> {
    const order = await this.findOrderForStaff(orderId);
    const transferRef = dto.transferRef?.trim();
    return this.transition(order, [ReturnStatus.REFUNDING], ReturnStatus.COMPLETED, { id: staffId, type: 'staff' }, {
      action: 'COMPLETE_RETURN_REFUND',
      changeNote: 'Shop đã hoàn tiền',
      note: [dto.note?.trim(), transferRef ? `Mã giao dịch: ${transferRef}` : ''].filter(Boolean).join(' — ') || undefined,
      set: { 'returnRequest.refundedAt': new Date(), ...(transferRef ? { 'returnRequest.refundTransferRef': transferRef } : {}) },
    });
  }

  async findAllAdmin(query: { page: number; limit: number; status?: ReturnStatus; search?: string }) {
    const page = Math.max(1, query.page);
    const limit = Math.min(50, Math.max(1, query.limit));
    const match: FilterQuery<OrderDocument> = { returnRequest: { $exists: true } };
    if (query.status) match['returnRequest.status'] = query.status;

    const pipeline: PipelineStage[] = [
      { $match: { ...match, isDeleted: { $ne: true } } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: '_user' } },
      { $unwind: { path: '$_user', preserveNullAndEmptyArrays: true } },
    ];
    if (query.search?.trim()) {
      // Escape special regex chars to prevent ReDoS
      const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pipeline.push({
        $match: {
          $or: [
            { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: escaped, options: 'i' } } },
            { '_user.name': { $regex: escaped, $options: 'i' } },
            { '_user.email': { $regex: escaped, $options: 'i' } },
            { 'shippingInfo.phone': { $regex: escaped, $options: 'i' } },
            { 'shippingInfo.recipientName': { $regex: escaped, $options: 'i' } },
          ],
        },
      });
    }

    const [countResult, rows, counts] = await Promise.all([
      this.orderModel.aggregate([...pipeline, { $count: 'total' }]),
      this.orderModel.aggregate([
        ...pipeline,
        { $sort: { 'returnRequest.requestedAt': -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $addFields: { userId: { _id: '$_user._id', name: '$_user.name', email: '$_user.email', phone: '$_user.phone' } } },
        { $project: { _user: 0, pendingNotificationEvents: 0 } },
      ]),
      this.orderModel.aggregate([
        { $match: { returnRequest: { $exists: true }, isDeleted: { $ne: true } } },
        { $group: { _id: '$returnRequest.status', count: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = Object.fromEntries(counts.map((c: { _id: string; count: number }) => [c._id, c.count]));
    const open = OPEN_RETURN_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
    return { data: rows, total: countResult[0]?.total ?? 0, page, limit, counts: { ...byStatus, OPEN: open } };
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async transition(
    order: OrderDocument,
    from: ReturnStatus[],
    to: ReturnStatus,
    actor: Actor,
    opts: { action: string; changeNote: string; note?: string; set?: Record<string, unknown> },
  ): Promise<OrderDocument> {
    const current = order.returnRequest?.status;
    if (!current) throw new BadRequestException('Đơn hàng chưa có yêu cầu trả hàng');
    if (!from.includes(current)) throw new BadRequestException(this.explainBadTransition(current));

    const entry: ReturnHistoryEntry = {
      status: to,
      at: new Date(),
      byType: actor.type,
      by: actor.id,
      ...(opts.note ? { note: opts.note } : {}),
    };
    const update: UpdateQuery<OrderDocument> = {
      $set: { 'returnRequest.status': to, ...(opts.set ?? {}) },
      $push: { 'returnRequest.history': entry },
      $inc: { currentVersion: 1 },
    };
    const updated = await this.orderModel
      .findOneAndUpdate({ _id: order._id, 'returnRequest.status': { $in: from } }, update, { new: true })
      .exec();
    if (!updated) {
      // Someone else moved the request first — report its real state.
      const fresh = await this.orderModel.findById(order._id).exec();
      throw new BadRequestException(this.explainBadTransition(fresh?.returnRequest?.status ?? current));
    }

    await this.afterTransition(updated, actor, opts.action, opts.changeNote, current);
    return updated;
  }

  private explainBadTransition(current: ReturnStatus): string {
    const messages: Record<ReturnStatus, string> = {
      [ReturnStatus.REQUESTED]: 'Yêu cầu đang chờ shop xem xét',
      [ReturnStatus.APPROVED]: 'Yêu cầu đã được duyệt, đang chờ khách gửi hàng',
      [ReturnStatus.SHIPPING_BACK]: 'Khách đã gửi hàng trả — không thể thay đổi bước này',
      [ReturnStatus.RECEIVED]: 'Shop đã nhận hàng trả và đang kiểm tra',
      [ReturnStatus.REFUNDING]: 'Hàng trả đã được kiểm tra, đang hoàn tiền',
      [ReturnStatus.COMPLETED]: 'Yêu cầu trả hàng đã hoàn tất',
      [ReturnStatus.REJECTED]: 'Yêu cầu trả hàng đã bị từ chối',
      [ReturnStatus.CANCELLED]: 'Yêu cầu trả hàng đã bị hủy',
    };
    return messages[current];
  }

  private async afterTransition(
    order: OrderDocument,
    actor: Actor,
    action: string,
    changeNote: string,
    fromStatus?: ReturnStatus,
  ): Promise<void> {
    await this.orderVersionModel.create({
      orderId: order._id,
      versionNumber: order.currentVersion,
      snapshot: order.toObject(),
      changedBy: actor.id,
      changedByType: actor.type,
      changeNote,
    });
    await this.auditService.log({
      actorId: actor.id,
      actorType: actor.type,
      action,
      module: 'order-returns',
      targetId: order._id.toString(),
      beforeData: fromStatus ? { returnStatus: fromStatus } : undefined,
      afterData: {
        returnStatus: order.returnRequest?.status,
        refundAmount: order.returnRequest?.refundAmount,
        returnShippingRefund: order.returnRequest?.returnShippingRefund,
      },
    });
  }
}
