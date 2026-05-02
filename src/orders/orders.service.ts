import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument, OrderStatus } from './schemas/order.schema';
import { OrderVersion, OrderVersionDocument } from './schemas/order-version.schema';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/order.dto';
import { ProductsService } from '../products/products.service';
import { CartService } from '../cart/cart.service';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderVersion.name)
    private readonly orderVersionModel: Model<OrderVersionDocument>,
    private readonly productsService: ProductsService,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
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

    const total = items.reduce((sum, item) => sum + item.subtotal, 0);

    const order = await this.orderModel.create({
      userId: new Types.ObjectId(userId),
      items,
      shippingInfo: dto.shippingInfo,
      total,
      status: OrderStatus.PENDING,
      currentVersion: 1,
    });

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

  async findAllAdmin(query: {
    page: number;
    limit: number;
    status?: OrderStatus;
    userId?: string;
  }) {
    const { page, limit, status, userId } = query;
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
      beforeData: before,
      afterData: updated.toObject(),
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
