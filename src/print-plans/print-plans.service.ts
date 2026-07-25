import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { PrintPlan, PrintPlanDocument, PrintPlanStatus } from './schemas/print-plan.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreatePrintPlanDto, UpdatePrintPlanDto, UpdatePrintPlanStatusDto } from './dto/print-plan.dto';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class PrintPlansService {
  constructor(
    @InjectModel(PrintPlan.name)
    private readonly printPlanModel: Model<PrintPlanDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly auditService: AuditService,
  ) {}

  /** Mã kế hoạch in ngẫu nhiên (không tuần tự), VD: 483920/IN-2026 */
  private genPlanCode(): string {
    const year = new Date().getFullYear();
    const num = crypto.randomInt(0, 1_000_000);
    return `${String(num).padStart(6, '0')}/IN-${year}`;
  }

  /** Nếu có productId thì lấy tên thật từ DB (không tin tưởng tên client gửi lên). */
  private async resolveProductName(productId: string | undefined, fallbackName: string): Promise<string> {
    if (!productId) return fallbackName;
    const product = await this.productModel.findById(productId).select('name').lean().exec();
    if (!product) throw new BadRequestException('Sản phẩm không tồn tại');
    return product.name;
  }

  async create(dto: CreatePrintPlanDto, staffId: string): Promise<PrintPlanDocument> {
    const productName = await this.resolveProductName(dto.productId, dto.productName);

    // Retry khi trùng mã (unique index, cực hiếm — sinh lại mã mới)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const plan = await this.printPlanModel.create({
          code: this.genPlanCode(),
          productId: dto.productId ? new Types.ObjectId(dto.productId) : undefined,
          productName,
          quantity: dto.quantity,
          deliveryDate: new Date(dto.deliveryDate),
          source: dto.source,
          note: dto.note ?? '',
          status: PrintPlanStatus.NEW,
          createdBy: new Types.ObjectId(staffId),
        });

        await this.auditService.log({
          actorId: staffId,
          actorType: 'staff',
          action: 'PRINT_PLAN_CREATE',
          module: 'print-plans',
          targetId: plan._id.toString(),
          afterData: { code: plan.code, productName: plan.productName, quantity: plan.quantity },
        });

        return plan;
      } catch (err: any) {
        if (err?.code === 11000 && attempt < 2) continue;
        throw err;
      }
    }
    throw new BadRequestException('Không thể tạo mã kế hoạch in, vui lòng thử lại');
  }

  async findAll(query: {
    page: number;
    limit: number;
    status?: PrintPlanStatus;
    source?: string;
    search?: string;
  }) {
    const { page, limit, status, source, search } = query;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { code: { $regex: escaped, $options: 'i' } },
        { productName: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.printPlanModel
        .find(filter)
        .populate('createdBy', 'name email')
        .sort({ deliveryDate: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.printPlanModel.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findById(id: string): Promise<PrintPlanDocument> {
    const doc = await this.printPlanModel.findById(id).populate('createdBy', 'name email').exec();
    if (!doc) throw new NotFoundException('Không tìm thấy kế hoạch in');
    return doc;
  }

  async update(id: string, dto: UpdatePrintPlanDto, staffId: string): Promise<PrintPlanDocument> {
    const doc = await this.printPlanModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy kế hoạch in');

    const before = {
      productName: doc.productName,
      quantity: doc.quantity,
      deliveryDate: doc.deliveryDate,
      source: doc.source,
      note: doc.note,
    };

    if (dto.productId !== undefined) {
      doc.productId = dto.productId ? new Types.ObjectId(dto.productId) : undefined;
      doc.productName = await this.resolveProductName(dto.productId, dto.productName ?? doc.productName);
    } else if (dto.productName !== undefined) {
      doc.productName = dto.productName;
    }
    if (dto.quantity !== undefined) doc.quantity = dto.quantity;
    if (dto.deliveryDate !== undefined) doc.deliveryDate = new Date(dto.deliveryDate);
    if (dto.source !== undefined) doc.source = dto.source;
    if (dto.note !== undefined) doc.note = dto.note;

    await doc.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'PRINT_PLAN_UPDATE',
      module: 'print-plans',
      targetId: id,
      beforeData: before,
      afterData: {
        productName: doc.productName,
        quantity: doc.quantity,
        deliveryDate: doc.deliveryDate,
        source: doc.source,
        note: doc.note,
      },
    });

    return doc;
  }

  async updateStatus(id: string, dto: UpdatePrintPlanStatusDto, staffId: string): Promise<PrintPlanDocument> {
    const doc = await this.printPlanModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy kế hoạch in');

    const before = { status: doc.status, errorReason: doc.errorReason };

    doc.status = dto.status;
    doc.errorReason = dto.status === PrintPlanStatus.ERROR ? (dto.errorReason ?? '') : '';

    await doc.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'PRINT_PLAN_UPDATE_STATUS',
      module: 'print-plans',
      targetId: id,
      beforeData: before,
      afterData: { status: doc.status, errorReason: doc.errorReason },
    });

    return doc;
  }

  async softDelete(id: string, staffId: string): Promise<void> {
    const doc = await this.printPlanModel.findById(id).exec();
    if (!doc) throw new NotFoundException('Không tìm thấy kế hoạch in');

    doc.isDeleted = true;
    doc.deletedAt = new Date();
    doc.deletedBy = staffId;
    await doc.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'PRINT_PLAN_DELETE',
      module: 'print-plans',
      targetId: id,
    });
  }
}
