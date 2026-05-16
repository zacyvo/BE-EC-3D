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
import { CreateOrderDto, UpdateOrderStatusDto, AdminCreateOrderDto } from './dto/order.dto';
import { ProductsService } from '../products/products.service';
import { CartService } from '../cart/cart.service';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';
import { PromotionsService } from '../promotions/promotions.service';
import { UsersService } from '../users/users.service';

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
  ) {}

  async create(userId: string, dto: CreateOrderDto): Promise<OrderDocument> {
    // Validate and compute items
    const items = await Promise.all(
      dto.items.map(async (item) => {
        const product = await this.productsService.findById(item.productId, false);
        if (product.stock < item.quantity) {
          throw new BadRequestException(`Insufficient stock for ${product.name}`);
        }
        return {
          productId: new Types.ObjectId(item.productId),
          productName: product.name,
          productImage: product.images[0] || '',
          productSlug: product.slug,
          quantity: item.quantity,
          unitPrice: product.finalPrice,
          subtotal: product.finalPrice * item.quantity,
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
      shippingInfo: dto.shippingInfo,
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
        return {
          productId: new Types.ObjectId(item.productId),
          productName: product.name,
          productImage: product.images[0] || '',
          productSlug: product.slug,
          quantity: item.quantity,
          unitPrice: product.finalPrice,
          subtotal: product.finalPrice * item.quantity,
          ...(item.note ? { note: item.note } : {}),
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

    const total = subtotal - adminDiscountAmount;

    const order = await this.orderModel.create({
      userId: new Types.ObjectId(targetUserId),
      items,
      shippingInfo: dto.shippingInfo,
      subtotal,
      discountAmount: adminDiscountAmount,
      appliedCoupons: [],
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
