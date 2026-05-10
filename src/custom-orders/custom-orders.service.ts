import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CustomOrder, CustomOrderDocument, CustomOrderStatus } from './schemas/custom-order.schema';
import { CreateCustomOrderDto, UpdateCustomOrderStatusDto } from './dto/custom-order.dto';
import { AuditService } from '../audit/audit.service';
import { StaffRole } from '../auth/decorators/roles.decorator';

@Injectable()
export class CustomOrdersService {
  constructor(
    @InjectModel(CustomOrder.name)
    private readonly customOrderModel: Model<CustomOrderDocument>,
    private readonly auditService: AuditService,
  ) {}

  async create(userId: string, dto: CreateCustomOrderDto): Promise<CustomOrderDocument> {
    if (dto.images && dto.images.length > 3) {
      throw new BadRequestException('Tối đa 3 ảnh');
    }

    const customOrder = await this.customOrderModel.create({
      userId: new Types.ObjectId(userId),
      content: dto.content,
      images: dto.images ?? [],
      contactName: dto.contactName,
      contactPhone: dto.contactPhone,
      contactEmail: dto.contactEmail,
      status: CustomOrderStatus.PENDING,
    });

    await this.auditService.log({
      actorId: userId,
      actorType: 'user',
      action: 'CREATE_CUSTOM_ORDER',
      module: 'custom-orders',
      targetId: customOrder._id.toString(),
    });

    return customOrder;
  }

  async findByUser(userId: string, query: { page: number; limit: number }) {
    const { page, limit } = query;
    const filter = { userId: new Types.ObjectId(userId) };
    const [data, total] = await Promise.all([
      this.customOrderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.customOrderModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async findByIdForUser(id: string, userId: string): Promise<CustomOrderDocument> {
    const doc = await this.customOrderModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy yêu cầu');
    if (doc.userId.toString() !== userId) throw new ForbiddenException('Không có quyền truy cập');
    return doc;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async findAllAdmin(query: {
    page: number;
    limit: number;
    status?: CustomOrderStatus;
    search?: string;
  }) {
    const { page, limit, status, search } = query;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pipeline = [
        ...(Object.keys(filter).length ? [{ $match: filter }] : []),
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: '_user' } },
        { $unwind: { path: '$_user', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [
              { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: escaped, options: 'i' } } },
              { '_user.name': { $regex: escaped, $options: 'i' } },
              { '_user.email': { $regex: escaped, $options: 'i' } },
              { contactName: { $regex: escaped, $options: 'i' } },
              { contactEmail: { $regex: escaped, $options: 'i' } },
              { contactPhone: { $regex: escaped, $options: 'i' } },
            ],
          },
        },
      ];

      const [countResult, rows] = await Promise.all([
        this.customOrderModel.aggregate([...pipeline, { $count: 'total' }]),
        this.customOrderModel.aggregate([
          ...pipeline,
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
      ]);

      return { data: rows, total: countResult[0]?.total ?? 0, page, limit };
    }

    const [data, total] = await Promise.all([
      this.customOrderModel
        .find(filter)
        .populate('userId', 'name email avatar')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.customOrderModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async findByIdAdmin(id: string): Promise<CustomOrderDocument> {
    const doc = await this.customOrderModel
      .findById(id)
      .populate('userId', 'name email avatar phone')
      .exec();
    if (!doc) throw new NotFoundException('Không tìm thấy yêu cầu');
    return doc;
  }

  async updateStatus(
    id: string,
    dto: UpdateCustomOrderStatusDto,
    staffId: string,
    staffRole: StaffRole,
  ): Promise<CustomOrderDocument> {
    const doc = await this.customOrderModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy yêu cầu');

    if (doc.status === CustomOrderStatus.CANCELLED) {
      throw new BadRequestException('Không thể cập nhật yêu cầu đã hủy');
    }
    if (doc.status === CustomOrderStatus.COMPLETED && staffRole !== StaffRole.SUPER_ADMIN && staffRole !== StaffRole.ADMIN) {
      throw new BadRequestException('Chỉ Admin mới có thể thay đổi trạng thái đã hoàn thành');
    }

    const before = { status: doc.status, adminNote: doc.adminNote };

    doc.status = dto.status;
    if (dto.adminNote !== undefined) doc.adminNote = dto.adminNote;
    if (dto.cancelReason !== undefined) doc.cancelReason = dto.cancelReason;

    await doc.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'UPDATE_CUSTOM_ORDER_STATUS',
      module: 'custom-orders',
      targetId: id,
      beforeData: before,
      afterData: { status: dto.status, adminNote: dto.adminNote },
    });

    return doc;
  }

  async softDelete(id: string, staffId: string): Promise<void> {
    const doc = await this.customOrderModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy yêu cầu');

    doc.isDeleted = true;
    doc.deletedAt = new Date();
    doc.deletedBy = staffId;
    await doc.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'DELETE_CUSTOM_ORDER',
      module: 'custom-orders',
      targetId: id,
    });
  }
}
