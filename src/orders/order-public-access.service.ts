import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument, PaymentMethod } from './schemas/order.schema';
import { OrdersService } from './orders.service';
import type { PaymentInstructions } from '../payments/bank-transfer.service';
import { AuditService } from '../audit/audit.service';
import { StaffService } from '../staff/staff.service';
import { UsersService } from '../users/users.service';
import {
  ORDER_ACCESS_JWT_TTL,
  ORDER_ACCESS_JWT_TYPE,
  ORDER_ACCESS_LOCK_MINUTES,
  ORDER_ACCESS_MAX_ATTEMPTS,
  genOrderAccessCode,
  genOrderAccessToken,
  isUsableAccessPhone,
  maskAccessPhone,
  normalizeAccessCode,
  normalizeAccessPhone,
  orderPublicUrl,
  orderShortCode,
  safeEqual,
  streetMatches,
} from './order-public-access.util';

/** How many of a phone's most recent orders "Tra cứu đơn hàng" looks at. */
const LOOKUP_MAX_ORDERS = 50;

const WRONG_CREDENTIALS = 'Số điện thoại, mã bảo mật hoặc địa chỉ không đúng';

/** One order found by "Tra cứu đơn hàng" — already unlocked (accessJwt) for its own link. */
export interface LookedUpOrder {
  token: string;
  accessJwt: string;
  orderCode: string;
  status: Order['status'];
  total: number;
  itemCount: number;
  firstItemName: string;
  createdAt: Date;
}

/** What the admin gets back (after re-entering their password) to send to the customer. */
export interface OrderAccessCredentials {
  publicUrl: string;
  securityCode: string;
  phone: string;
  issuedAt?: Date;
}

/** The customer-facing view of an order — an explicit whitelist: no internal notes, staff ids,
 * account ids, payment history or worker state ever leave through the public link. */
export interface PublicOrderView {
  orderCode: string;
  status: Order['status'];
  paymentMethod: PaymentMethod;
  items: {
    productName: string;
    productImage: string;
    productSlug: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    color?: string;
    size?: string;
    note?: string;
  }[];
  subtotal: number;
  discountAmount: number;
  shippingFee: number;
  shippingDiscount: number;
  vatAmount: number;
  total: number;
  paidAmount: number;
  shippingInfo: {
    recipientName: string;
    phone: string;
    street: string;
    ward: string;
    district: string;
    city: string;
    note?: string;
  };
  delivery?: {
    carrierName?: string;
    trackingCode?: string;
    trackingUrl?: string;
    estimatedDeliveryDate?: Date;
  };
  customerNote?: string;
  csNote?: string;
  cancelReason?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class OrderPublicAccessService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly staffService: StaffService,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    /** Public payment (VietQR) of a guest order — optional so older specs construct without it. */
    @Optional() @Inject(forwardRef(() => OrdersService)) private readonly ordersService?: OrdersService,
  ) {}

  private publicUrl(token: string): string {
    return orderPublicUrl(this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000'), token);
  }

  private jwtSecret(): string {
    return this.configService.get<string>('JWT_SECRET') as string;
  }

  /** Right after "Tạo đơn" — the creator gets the link + code once, to send to the customer. */
  credentialsOfNewOrder(order: OrderDocument): OrderAccessCredentials | null {
    if (!order.publicAccessToken || !order.publicAccessCode || !order.publicAccessPhone) return null;
    return {
      publicUrl: this.publicUrl(order.publicAccessToken),
      securityCode: order.publicAccessCode,
      phone: order.publicAccessPhone,
      issuedAt: order.publicAccessIssuedAt,
    };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  /**
   * Xem (or, with `regenerate`, re-issue) the order's link + code. Like the contract's "Xem mã",
   * it needs the staff's own password again. Re-issuing changes BOTH the link and the code, so
   * whatever was sent before (and any open customer session) stops working. An order without a
   * link yet (created before this feature) gets one on first use.
   */
  async revealOrIssue(
    orderId: string,
    staffId: string,
    password: string,
    regenerate = false,
  ): Promise<OrderAccessCredentials> {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Order not found');
    const valid = await this.staffService.verifyPassword(staffId, password);
    if (!valid) throw new UnauthorizedException('Mật khẩu không đúng');

    const order = await this.orderModel.findById(orderId).select('+publicAccessCode').exec();
    if (!order) throw new NotFoundException('Order not found');

    if (order.publicAccessToken && order.publicAccessCode && !regenerate) {
      await this.auditService.log({
        actorId: staffId,
        actorType: 'staff',
        action: 'ORDER_PUBLIC_ACCESS_REVEAL',
        module: 'orders',
        targetId: orderId,
      });
      return this.credentialsOfNewOrder(order)!;
    }

    if (order.externalRef) {
      throw new BadRequestException(
        `Đơn ${order.externalRef.channel} được theo dõi trên sàn — không tạo link xem đơn`,
      );
    }
    const phone = await this.resolvePhone(order);
    if (!phone) {
      throw new BadRequestException('Đơn hàng chưa có số điện thoại hợp lệ của khách để tạo link xem đơn');
    }

    const updated = await this.orderModel
      .findByIdAndUpdate(
        orderId,
        {
          $set: {
            publicAccessToken: genOrderAccessToken(),
            publicAccessCode: genOrderAccessCode(),
            publicAccessPhone: phone,
            publicAccessIssuedAt: new Date(),
          },
          $unset: { publicAccessAttempts: 1, publicAccessLockedUntil: 1 },
        },
        { new: true },
      )
      .select('+publicAccessCode')
      .exec();
    if (!updated) throw new NotFoundException('Order not found');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: regenerate && order.publicAccessToken ? 'ORDER_PUBLIC_ACCESS_REGENERATE' : 'ORDER_PUBLIC_ACCESS_ISSUE',
      module: 'orders',
      targetId: orderId,
      afterData: { phone },
    });
    return this.credentialsOfNewOrder(updated)!;
  }

  /** Account phone first (what the customer knows as "their" number), else the recipient's. */
  private async resolvePhone(order: OrderDocument): Promise<string | undefined> {
    const user = order.userId ? await this.usersService.findById(order.userId.toString()) : null;
    const phone = [user?.phone, order.shippingInfo?.phone].find(isUsableAccessPhone);
    return phone ? normalizeAccessPhone(phone) : undefined;
  }

  // ─── Public (customer, no login) ────────────────────────────────────────────

  private async findByToken(token: string, withCode = false): Promise<OrderDocument> {
    // Tokens are 48 hex chars — anything else can't match; skip the query.
    if (!/^[a-f0-9]{48}$/.test(token)) throw new NotFoundException('Liên kết không hợp lệ hoặc đã hết hiệu lực');
    const q = this.orderModel.findOne({ publicAccessToken: token });
    const order = await (withCode ? q.select('+publicAccessCode') : q).exec();
    if (!order || !order.publicAccessPhone) {
      throw new NotFoundException('Liên kết không hợp lệ hoặc đã hết hiệu lực');
    }
    return order;
  }

  /** Bare minimum for the unlock screen. */
  async getMeta(token: string) {
    const order = await this.findByToken(token);
    return {
      orderCode: orderShortCode(order._id.toString()),
      maskedPhone: maskAccessPhone(order.publicAccessPhone!),
    };
  }

  /** Phone + (security code | delivery street — "Quên mã bảo mật"). */
  private credentialsOk(
    order: OrderDocument,
    phone: string,
    securityCode?: string,
    street?: string,
  ): boolean {
    if (normalizeAccessPhone(phone) !== order.publicAccessPhone) return false;
    if (securityCode?.trim()) {
      return !!order.publicAccessCode && safeEqual(normalizeAccessCode(securityCode), order.publicAccessCode);
    }
    return streetMatches(street, order.shippingInfo?.street);
  }

  private lockedMinutes(order: OrderDocument): number | null {
    if (!order.publicAccessLockedUntil || order.publicAccessLockedUntil <= new Date()) return null;
    return Math.ceil((order.publicAccessLockedUntil.getTime() - Date.now()) / 60000);
  }

  /** Wrong guess on these orders. Atomic $inc: parallel guesses can't each read the same counter
   * and slip past the lock. */
  private async recordFailure(orderIds: Types.ObjectId[]): Promise<void> {
    if (!orderIds.length) return;
    await this.orderModel.updateMany({ _id: { $in: orderIds } }, { $inc: { publicAccessAttempts: 1 } }).exec();
    await this.orderModel
      .updateMany(
        { _id: { $in: orderIds }, publicAccessAttempts: { $gte: ORDER_ACCESS_MAX_ATTEMPTS } },
        {
          $set: { publicAccessLockedUntil: new Date(Date.now() + ORDER_ACCESS_LOCK_MINUTES * 60_000) },
          $unset: { publicAccessAttempts: 1 },
        },
      )
      .exec();
  }

  private async clearFailures(orders: OrderDocument[]): Promise<void> {
    const ids = orders.filter((o) => o.publicAccessAttempts || o.publicAccessLockedUntil).map((o) => o._id);
    if (!ids.length) return;
    await this.orderModel
      .updateMany({ _id: { $in: ids } }, { $unset: { publicAccessAttempts: 1, publicAccessLockedUntil: 1 } })
      .exec();
  }

  /** The token is part of the session: re-issuing the link ends every session opened with the old one. */
  issueSession(order: OrderDocument): Promise<string> {
    return this.jwtService.signAsync(
      { sub: order._id.toString(), typ: ORDER_ACCESS_JWT_TYPE, tk: order.publicAccessToken },
      { secret: this.jwtSecret(), expiresIn: ORDER_ACCESS_JWT_TTL },
    );
  }

  async verify(token: string, phone: string, securityCode?: string, street?: string) {
    const order = await this.findByToken(token, true);

    const minutes = this.lockedMinutes(order);
    if (minutes) throw new ForbiddenException(`Nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút`);

    if (!this.credentialsOk(order, phone, securityCode, street)) {
      await this.recordFailure([order._id]);
      throw new UnauthorizedException(
        securityCode?.trim() ? 'Số điện thoại hoặc mã bảo mật không đúng' : 'Số điện thoại hoặc địa chỉ nhận hàng không đúng',
      );
    }

    await this.clearFailures([order]);
    const accessJwt = await this.issueSession(order);
    return { accessJwt, order: this.toPublicView(order) };
  }

  /**
   * "Tra cứu đơn hàng" — the customer has lost the link: phone + security code finds that order,
   * phone + delivery street finds every order of that phone delivered there. Unknown phone and
   * wrong credentials answer the same (no "this phone has orders" oracle); each wrong guess counts
   * against all of the phone's orders, so the 5-tries lock still bounds guessing.
   */
  async lookup(phone: string, securityCode?: string, street?: string): Promise<{ orders: LookedUpOrder[] }> {
    const normalized = normalizeAccessPhone(phone);
    if (!isUsableAccessPhone(normalized)) throw new UnauthorizedException(WRONG_CREDENTIALS);

    const candidates = await this.orderModel
      .find({ publicAccessPhone: normalized, publicAccessToken: { $exists: true } })
      .select('+publicAccessCode')
      .sort({ createdAt: -1, _id: -1 })
      .limit(LOOKUP_MAX_ORDERS)
      .exec();

    const open = candidates.filter((o) => !this.lockedMinutes(o));
    if (candidates.length && !open.length) {
      const minutes = Math.min(...candidates.map((o) => this.lockedMinutes(o) ?? ORDER_ACCESS_LOCK_MINUTES));
      throw new ForbiddenException(`Nhập sai quá nhiều lần. Vui lòng thử lại sau ${minutes} phút`);
    }

    const matched = open.filter((o) => this.credentialsOk(o, normalized, securityCode, street));
    if (!matched.length) {
      await this.recordFailure(open.map((o) => o._id));
      throw new UnauthorizedException(WRONG_CREDENTIALS);
    }

    await this.clearFailures(matched);
    const orders = await Promise.all(
      matched.map(async (o) => ({
        token: o.publicAccessToken!,
        accessJwt: await this.issueSession(o),
        orderCode: orderShortCode(o._id.toString()),
        status: o.status,
        total: o.total,
        itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
        firstItemName: o.items[0]?.productName ?? '',
        createdAt: o.createdAt,
      })),
    );
    return { orders };
  }

  /** The order behind a valid customer session for this link. */
  private async authorize(token: string, accessJwt?: string): Promise<OrderDocument> {
    if (!accessJwt) throw new UnauthorizedException('Vui lòng xác thực để xem đơn hàng');
    let payload: { sub?: string; typ?: string; tk?: string };
    try {
      payload = await this.jwtService.verifyAsync(accessJwt, { secret: this.jwtSecret() });
    } catch {
      throw new UnauthorizedException('Phiên đã hết hạn, vui lòng xác thực lại');
    }
    if (payload.typ !== ORDER_ACCESS_JWT_TYPE || payload.tk !== token) {
      throw new UnauthorizedException('Phiên không hợp lệ');
    }
    const order = await this.findByToken(token);
    if (payload.sub !== order._id.toString()) throw new UnauthorizedException('Phiên không hợp lệ');
    return order;
  }

  async getOrder(token: string, accessJwt?: string): Promise<PublicOrderView> {
    return this.toPublicView(await this.authorize(token, accessJwt));
  }

  /** VietQR instructions of a bank-transfer order, through its link (guest has no login). */
  async getPayment(token: string, accessJwt?: string): Promise<PaymentInstructions> {
    const order = await this.authorize(token, accessJwt);
    if (!this.ordersService) throw new BadRequestException('Thanh toán tạm thời không khả dụng');
    return this.ordersService.getPaymentForUser(order._id.toString(), order.userId.toString());
  }

  /** "Tôi đã chuyển khoản" through the link — same customer claim as the logged-in flow. */
  async reportPayment(token: string, accessJwt?: string) {
    const order = await this.authorize(token, accessJwt);
    if (!this.ordersService) throw new BadRequestException('Thanh toán tạm thời không khả dụng');
    return this.ordersService.reportPaymentByUser(order._id.toString(), order.userId.toString());
  }

  toPublicView(order: OrderDocument): PublicOrderView {
    const si = order.shippingInfo;
    const d = order.delivery;
    const hasDelivery = !!(d?.carrierName || d?.trackingCode || d?.trackingUrl || d?.estimatedDeliveryDate);
    return {
      orderCode: orderShortCode(order._id.toString()),
      status: order.status,
      paymentMethod: order.paymentMethod ?? PaymentMethod.COD,
      items: order.items.map((i) => ({
        productName: i.productName,
        productImage: i.productImage,
        productSlug: i.productSlug,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
        ...(i.color ? { color: i.color } : {}),
        ...(i.size ? { size: i.size } : {}),
        ...(i.note ? { note: i.note } : {}),
      })),
      subtotal: order.subtotal,
      discountAmount: order.discountAmount ?? 0,
      shippingFee: order.shippingFee ?? 0,
      shippingDiscount: order.shippingDiscount ?? 0,
      vatAmount: order.vatAmount ?? 0,
      total: order.total,
      paidAmount: order.paidAmount ?? 0,
      shippingInfo: {
        recipientName: si.recipientName,
        phone: si.phone,
        street: si.street,
        ward: si.ward,
        district: si.district ?? '',
        city: si.city,
        ...(si.note ? { note: si.note } : {}),
      },
      ...(hasDelivery
        ? {
            delivery: {
              carrierName: d!.carrierName,
              trackingCode: d!.trackingCode,
              trackingUrl: d!.trackingUrl,
              estimatedDeliveryDate: d!.estimatedDeliveryDate,
            },
          }
        : {}),
      ...(order.customerNote ? { customerNote: order.customerNote } : {}),
      ...(order.csNote ? { csNote: order.csNote } : {}),
      ...(order.cancelReason ? { cancelReason: order.cancelReason } : {}),
      ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
