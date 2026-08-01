import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, PipelineStage } from 'mongoose';
import { Order, OrderDocument, OrderStatus } from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument } from './schemas/order-version.schema';
import { CreateOrderDto, UpdateOrderStatusDto, AdminCreateOrderDto, ShippingInfoDto } from './dto/order.dto';
import { ProductsService } from '../products/products.service';
import { CartService } from '../cart/cart.service';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';
import { PromotionsService } from '../promotions/promotions.service';
import { UsersService } from '../users/users.service';
import { AddressConversionService } from '../locations/address-conversion.service';

/** One imported line item — already resolved to a catalog product by the caller
 * (e.g. ShopeeOrderSyncService); OrdersService just persists it as-is. */
export interface ExternalOrderItemInput {
  productId: string;
  productName: string;
  productImage: string;
  productSlug: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  note?: string;
  color?: string;
  size?: string;
}

export interface ExternalOrderShippingInput {
  recipientName: string;
  phone: string;
  street: string;
  ward: string;
  district?: string;
  city: string;
  note?: string;
}

/** Input for importing/syncing one order from an external marketplace (e.g. Shopee's
 * Excel export). Dedup key is (channel, code) — see importExternalOrder(). */
export interface ImportExternalOrderInput {
  channel: string;
  code: string;
  packageCode?: string;
  items: ExternalOrderItemInput[];
  shippingInfo: ExternalOrderShippingInput;
  subtotal: number;
  shippingFee: number;
  discountAmount: number;
  total: number;
  status: OrderStatus;
  delivery?: { carrierName?: string; trackingCode?: string; trackingUrl?: string; estimatedDeliveryDate?: Date };
  /** Original marketplace order date — preserved as Order.createdAt on creation only. */
  orderDate?: Date;
  paidAmount?: number;
  buyer: {
    /** Marketplace's own buyer id (e.g. Shopee "Người Mua" username) — used to find/create
     * a guest account when `phone` is absent (masked by the source). */
    externalBuyerId: string;
    /** Only a real, unmasked phone number — never a masked display string. */
    phone?: string;
  };
  /** Set only on creation (never re-applied on update) — e.g. a one-time traceability note. */
  adminNoteOnCreate?: string;
  staffId: string;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderVersion.name)
    private readonly orderVersionModel: Model<OrderVersionDocument>,
    private readonly productsService: ProductsService,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
    private readonly promotionsService: PromotionsService,
    private readonly usersService: UsersService,
    private readonly addressConversionService: AddressConversionService,
  ) {}

  /** Validates the selected color/size against the product's configured options
   * (if any) and resolves the image to snapshot for this order item. */
  private resolveVariant(
    product: { colors: { name: string; images: string[] }[]; sizes: string[]; images: string[]; name: string },
    color?: string,
    size?: string,
  ): { color?: string; size?: string; image: string } {
    let matchedColor: { name: string; images: string[] } | undefined;
    if (product.colors?.length) {
      matchedColor = product.colors.find((c) => c.name === color);
      if (!matchedColor) {
        throw new BadRequestException(`Vui lòng chọn màu hợp lệ cho ${product.name}`);
      }
    }
    if (product.sizes?.length && !product.sizes.includes(size || '')) {
      throw new BadRequestException(`Vui lòng chọn size hợp lệ cho ${product.name}`);
    }
    const image = matchedColor?.images?.[0] || product.images[0] || '';
    return {
      ...(matchedColor ? { color: matchedColor.name } : {}),
      ...(product.sizes?.length ? { size } : {}),
      image,
    };
  }

  /** If shippingInfo carries an `oldAddress` selection, resolves it via
   * AddressConversionService and overwrites ward/city with the authoritative
   * result -- client-submitted ward/city are ignored in that case. */
  private resolveShippingInfo(shippingInfo: CreateOrderDto['shippingInfo']) {
    if (!shippingInfo.oldAddress) return shippingInfo;
    const entry = this.addressConversionService.resolve(
      shippingInfo.oldAddress.districtCode,
      shippingInfo.oldAddress.wardCode,
    );
    return {
      ...shippingInfo,
      ward: entry.newWard,
      city: entry.newProvince,
      oldAddress: {
        province: entry.oldProvince,
        district: entry.oldDistrict,
        ward: entry.oldWard,
        districtCode: entry.districtCode,
        wardCode: entry.wardCode,
      },
    };
  }

  async create(userId: string, dto: CreateOrderDto): Promise<OrderDocument> {
    // Validate and compute items
    const items = await Promise.all(
      dto.items.map(async (item) => {
        const product = await this.productsService.findById(item.productId, false);
        if (product.stock < item.quantity) {
          throw new BadRequestException(`Insufficient stock for ${product.name}`);
        }
        const variant = this.resolveVariant(product, item.color, item.size);
        return {
          productId: new Types.ObjectId(item.productId),
          productName: product.name,
          productImage: variant.image,
          productSlug: product.slug,
          quantity: item.quantity,
          unitPrice: product.finalPrice,
          subtotal: product.finalPrice * item.quantity,
          ...(variant.color ? { color: variant.color } : {}),
          ...(variant.size ? { size: variant.size } : {}),
        };
      }),
    );

    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);

    // Apply coupon codes (floor rule enforced inside validateCoupons)
    let discountAmount = 0;
    let appliedCoupons: { code: string; name: string; discountAmount: number }[] = [];
    if (dto.couponCodes?.length) {
      const validation = await this.promotionsService.validateCoupons(userId, {
        couponCodes: dto.couponCodes,
        orderTotal: subtotal,
      });
      discountAmount = validation.totalDiscount;
      appliedCoupons = validation.appliedCoupons;
    }

    const total = subtotal - discountAmount;

    const order = await this.orderModel.create({
      userId: new Types.ObjectId(userId),
      items,
      shippingInfo: this.resolveShippingInfo(dto.shippingInfo),
      subtotal,
      discountAmount,
      appliedCoupons,
      total,
      status: OrderStatus.PENDING,
      currentVersion: 1,
      ...(dto.customerNote ? { customerNote: dto.customerNote } : {}),
    });

    // Mark coupons as used
    if (appliedCoupons.length) {
      await this.promotionsService.markUsed(
        userId,
        appliedCoupons.map((c) => c.code),
      );
    }

    // Save initial version snapshot
    await this.saveVersion(order, userId, 'user', 'Order created');

    // Clear cart
    await this.cartService.clearCart(userId);

    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'CREATE_ORDER',
      module: 'orders',
      targetId: order._id.toString(),
    });

    return order;
  }

  async createForAdmin(staffId: string, dto: AdminCreateOrderDto): Promise<OrderDocument> {
    // Resolve target userId
    let targetUserId: string;

    if (dto.userId) {
      const user = await this.usersService.findById(dto.userId);
      if (!user) throw new NotFoundException('User not found');
      targetUserId = dto.userId;
    } else if (dto.guestInfo) {
      const { user } = await this.usersService.findOrCreateByPhone(
        dto.guestInfo.phone,
        dto.guestInfo.name,
      );
      targetUserId = user._id.toString();
    } else {
      throw new BadRequestException('Provide either userId or guestInfo');
    }

    // Validate and compute items
    const items = await Promise.all(
      dto.items.map(async (item) => {
        const product = await this.productsService.findById(item.productId, false);
        if (product.stock < item.quantity) {
          throw new BadRequestException(`Không đủ hàng: ${product.name}`);
        }
        const variant = this.resolveVariant(product, item.color, item.size);
        return {
          productId: new Types.ObjectId(item.productId),
          productName: product.name,
          productImage: variant.image,
          productSlug: product.slug,
          quantity: item.quantity,
          unitPrice: product.finalPrice,
          subtotal: product.finalPrice * item.quantity,
          ...(item.note ? { note: item.note } : {}),
          ...(variant.color ? { color: variant.color } : {}),
          ...(variant.size ? { size: variant.size } : {}),
        };
      }),
    );

    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);

    // Apply admin direct discount (bypasses coupon system)
    let adminDiscountAmount = 0;
    let adminDirectDiscount: { type: 'AMOUNT' | 'PERCENT'; value: number; reason?: string; amount: number } | undefined;
    if (dto.adminDiscount) {
      const { type, value, reason } = dto.adminDiscount;
      if (type === 'PERCENT') {
        adminDiscountAmount = Math.round((subtotal * Math.min(value, 100)) / 100);
      } else {
        adminDiscountAmount = Math.min(value, subtotal);
      }
      adminDirectDiscount = { type, value, reason, amount: adminDiscountAmount };
    }

    const shippingFee = dto.shippingFee ?? 0;
    const total = subtotal - adminDiscountAmount + shippingFee;

    const order = await this.orderModel.create({
      userId: new Types.ObjectId(targetUserId),
      items,
      shippingInfo: this.resolveShippingInfo(dto.shippingInfo),
      subtotal,
      discountAmount: adminDiscountAmount,
      appliedCoupons: [],
      shippingFee,
      total,
      ...(adminDirectDiscount ? { adminDirectDiscount } : {}),
      status: OrderStatus.PENDING,
      currentVersion: 1,
      createdByAdmin: true,
      createdByStaffId: staffId,
      ...(dto.customerNote ? { customerNote: dto.customerNote } : {}),
      ...(dto.adminNote ? { adminNote: dto.adminNote } : {}),
    });

    await this.saveVersion(order, staffId, 'staff', 'Order created by admin');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'ADMIN_CREATE_ORDER',
      module: 'orders',
      targetId: order._id.toString(),
    });

    return order;
  }

  async findByExternalRef(channel: string, code: string): Promise<OrderDocument | null> {
    return this.orderModel.findOne({ 'externalRef.channel': channel, 'externalRef.code': code }).exec();
  }

  /** Create-or-update entry point for marketplace order sync (e.g. Shopee's Excel
   * export). Dedup key is (channel, code): a re-uploaded row for an already-imported
   * order updates it in place instead of creating a duplicate. */
  async importExternalOrder(input: ImportExternalOrderInput): Promise<{ order: OrderDocument; created: boolean }> {
    const existing = await this.findByExternalRef(input.channel, input.code);
    if (existing) {
      return { order: await this.applyExternalOrderUpdate(existing, input), created: false };
    }
    return { order: await this.createExternalOrder(input), created: true };
  }

  private async createExternalOrder(input: ImportExternalOrderInput): Promise<OrderDocument> {
    const { user } = input.buyer.phone
      ? await this.usersService.findOrCreateByPhone(input.buyer.phone, input.shippingInfo.recipientName)
      : await this.usersService.findOrCreateByExternalBuyer(
          input.channel,
          input.buyer.externalBuyerId,
          input.shippingInfo.recipientName,
        );

    const order = await this.orderModel.create({
      userId: user._id,
      items: input.items.map((i) => ({
        productId: new Types.ObjectId(i.productId),
        productName: i.productName,
        productImage: i.productImage,
        productSlug: i.productSlug,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
        ...(i.note ? { note: i.note } : {}),
        ...(i.color ? { color: i.color } : {}),
        ...(i.size ? { size: i.size } : {}),
      })),
      shippingInfo: {
        recipientName: input.shippingInfo.recipientName,
        phone: input.shippingInfo.phone,
        street: input.shippingInfo.street,
        ward: input.shippingInfo.ward,
        district: input.shippingInfo.district || '',
        city: input.shippingInfo.city,
        ...(input.shippingInfo.note ? { note: input.shippingInfo.note } : {}),
      },
      subtotal: input.subtotal,
      discountAmount: input.discountAmount,
      appliedCoupons: [],
      shippingFee: input.shippingFee,
      total: input.total,
      status: input.status,
      currentVersion: 1,
      createdByAdmin: true,
      createdByStaffId: input.staffId,
      externalRef: {
        channel: input.channel,
        code: input.code,
        ...(input.packageCode ? { packageCode: input.packageCode } : {}),
      },
      ...(input.paidAmount !== undefined ? { paidAmount: input.paidAmount } : {}),
      ...(input.adminNoteOnCreate ? { adminNote: input.adminNoteOnCreate } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.orderDate ? { createdAt: input.orderDate } : {}),
    });

    await this.saveVersion(order, input.staffId, 'staff', `Đơn hàng đồng bộ từ ${input.channel}`);

    await this.auditService.log({
      actorId: input.staffId,
      actorType: 'staff',
      action: 'IMPORT_EXTERNAL_ORDER',
      module: 'orders',
      targetId: order._id.toString(),
      afterData: order.toObject() as unknown as Record<string, unknown>,
    });

    return order;
  }

  /** Only overwrites a shipping field when the incoming value is a genuine improvement
   * (fills a blank, or replaces a masked value with an unmasked one) — never regresses
   * a good/manually-fixed value back to something worse on a later sync. */
  private isImprovedShippingValue(incoming: string, current: string): boolean {
    if (!incoming) return false;
    if (!current) return true;
    return current.includes('*') && !incoming.includes('*');
  }

  private async applyExternalOrderUpdate(
    order: OrderDocument,
    input: ImportExternalOrderInput,
  ): Promise<OrderDocument> {
    const before = order.toObject();

    order.status = input.status;
    if (input.delivery) order.delivery = { ...order.delivery, ...input.delivery } as any;
    if (input.paidAmount !== undefined) order.paidAmount = input.paidAmount;
    if (input.packageCode && order.externalRef) order.externalRef.packageCode = input.packageCode;

    const si = order.shippingInfo;
    const incoming = input.shippingInfo;
    if (this.isImprovedShippingValue(incoming.recipientName, si.recipientName)) si.recipientName = incoming.recipientName;
    if (this.isImprovedShippingValue(incoming.phone, si.phone)) si.phone = incoming.phone;
    if (this.isImprovedShippingValue(incoming.street, si.street)) si.street = incoming.street;
    if (this.isImprovedShippingValue(incoming.ward, si.ward)) si.ward = incoming.ward;
    if (incoming.city && this.isImprovedShippingValue(incoming.city, si.city)) si.city = incoming.city;

    order.currentVersion += 1;
    const updated = await order.save();

    await this.saveVersion(updated, input.staffId, 'staff', `Đồng bộ cập nhật từ ${input.channel}`);

    await this.auditService.log({
      actorId: input.staffId,
      actorType: 'staff',
      action: 'SYNC_UPDATE_EXTERNAL_ORDER',
      module: 'orders',
      targetId: updated._id.toString(),
      beforeData: before as unknown as Record<string, unknown>,
      afterData: updated.toObject() as unknown as Record<string, unknown>,
    });

    return updated;
  }

  /** Admin-only manual fix for recipient info (e.g. completing a Shopee-masked
   * address) — reuses the same DTO/validation as a normal order's shippingInfo. */
  async updateShippingInfo(orderId: string, dto: ShippingInfoDto, staffId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');

    const before = order.toObject();
    order.shippingInfo = this.resolveShippingInfo(dto) as any;
    order.currentVersion += 1;
    const updated = await order.save();

    await this.saveVersion(updated, staffId, 'staff', 'Cập nhật thông tin nhận hàng');

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'UPDATE_ORDER_SHIPPING_INFO',
      module: 'orders',
      targetId: orderId,
      beforeData: before as unknown as Record<string, unknown>,
      afterData: updated.toObject() as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async findByUser(
    userId: string,
    query: { page: number; limit: number },
  ) {
    const { page, limit } = query;
    const [data, total] = await Promise.all([
      this.orderModel
        .find({ userId: new Types.ObjectId(userId) })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments({ userId: new Types.ObjectId(userId) }).exec(),
    ]);
    return { data, total, page, limit };
  }

  async findByIdForUser(orderId: string, userId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId.toString() !== userId) throw new ForbiddenException('Access denied');
    return order;
  }

  async getUserStats(userId: string): Promise<{ totalOrders: number; deliveredOrders: number; totalSpent: number }> {
    const uid = new Types.ObjectId(userId);
    const [allResult, deliveredResult] = await Promise.all([
      this.orderModel.countDocuments({ userId: uid }),
      this.orderModel.aggregate([
        { $match: { userId: uid, status: OrderStatus.DELIVERED } },
        { $group: { _id: null, count: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
      ]),
    ]);
    return {
      totalOrders: allResult,
      deliveredOrders: deliveredResult[0]?.count ?? 0,
      totalSpent: deliveredResult[0]?.totalSpent ?? 0,
    };
  }

  async findAllAdmin(query: {
    page: number;
    limit: number;
    status?: OrderStatus;
    userId?: string;
    search?: string;
  }) {
    const { page, limit, status, userId, search } = query;

    if (search) {
      // Escape special regex chars to prevent ReDoS
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const baseMatch: Record<string, unknown> = {};
      if (status) baseMatch.status = status;
      if (userId) baseMatch.userId = new Types.ObjectId(userId);

      const pipeline: PipelineStage[] = [
        ...(Object.keys(baseMatch).length ? [{ $match: baseMatch }] : []),
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: '_user' } },
        { $unwind: { path: '$_user', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [
              { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: escaped, options: 'i' } } },
              { '_user.name': { $regex: escaped, $options: 'i' } },
              { '_user.email': { $regex: escaped, $options: 'i' } },
            ],
          },
        },
      ];

      const [countResult, rows] = await Promise.all([
        this.orderModel.aggregate([...pipeline, { $count: 'total' }]),
        this.orderModel.aggregate([
          ...pipeline,
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $addFields: { userId: '$_user' } },
          { $project: { _user: 0 } },
        ]),
      ]);

      return { data: rows, total: countResult[0]?.total ?? 0, page, limit };
    }

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (userId) filter.userId = new Types.ObjectId(userId);

    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .populate('userId', 'name email phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async updateStatus(
    orderId: string,
    dto: UpdateOrderStatusDto,
    staffId: string,
    staffRole: StaffRole,
  ): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');

    const before = order.toObject();

    // CS can only update status (not cancel)
    if (staffRole === StaffRole.CS && dto.status === OrderStatus.CANCELLED) {
      throw new ForbiddenException('CS cannot cancel orders');
    }

    order.status = dto.status;
    if (dto.csNote) order.csNote = dto.csNote;
    if (dto.cancelReason) order.cancelReason = dto.cancelReason;
    if (dto.delivery !== undefined) order.delivery = dto.delivery as any;
    if (dto.paidAmount !== undefined) order.paidAmount = dto.paidAmount;
    order.currentVersion += 1;

    const updated = await order.save();

    // Save version snapshot
    await this.saveVersion(updated, staffId, 'staff', `Status changed to ${dto.status}`);

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'UPDATE_ORDER_STATUS',
      module: 'orders',
      targetId: orderId,
      beforeData: before as unknown as Record<string, unknown>,
      afterData: updated.toObject() as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async getOrderVersions(orderId: string) {
    return this.orderVersionModel
      .find({ orderId: new Types.ObjectId(orderId) })
      .sort({ versionNumber: -1 })
      .exec();
  }

  private async saveVersion(
    order: OrderDocument,
    changedBy: string,
    changedByType: 'user' | 'staff',
    changeNote?: string,
  ) {
    await this.orderVersionModel.create({
      orderId: order._id,
      versionNumber: order.currentVersion,
      snapshot: order.toObject(),
      changedBy,
      changedByType,
      changeNote,
    });
  }

  async softDelete(orderId: string, staffId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    order.isDeleted = true;
    order.deletedAt = new Date();
    order.deletedBy = staffId;
    await order.save();
  }
}
