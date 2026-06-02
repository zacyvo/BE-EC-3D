import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  WarehouseExport,
  WarehouseExportDocument,
} from './schemas/warehouse-export.schema';
import { CreateWarehouseExportDto } from './dto/warehouse-export.dto';

@Injectable()
export class WarehouseExportsService {
  constructor(
    @InjectModel(WarehouseExport.name)
    private readonly exportModel: Model<WarehouseExportDocument>,
  ) {}

  async create(
    dto: CreateWarehouseExportDto,
    staffId: string,
  ): Promise<WarehouseExportDocument> {
    return this.exportModel.create({
      ...dto,
      createdBy: new Types.ObjectId(staffId),
    });
  }

  async findAll(params: {
    page: number;
    limit: number;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }) {
    const { page, limit, search, fromDate, toDate } = params;
    const filter: Record<string, unknown> = {};

    if (search) {
      filter.$or = [
        { recipientName: { $regex: search, $options: 'i' } },
        { recipientPhone: { $regex: search, $options: 'i' } },
        { 'items.productName': { $regex: search, $options: 'i' } },
      ];
    }

    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate)
        (filter.createdAt as Record<string, unknown>).$gte = new Date(fromDate);
      if (toDate)
        (filter.createdAt as Record<string, unknown>).$lte = new Date(toDate);
    }

    const [data, total] = await Promise.all([
      this.exportModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .lean(),
      this.exportModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: string): Promise<WarehouseExportDocument> {
    const doc = await this.exportModel
      .findById(id)
      .populate('createdBy', 'name email')
      .exec();
    if (!doc) throw new NotFoundException('Warehouse export not found');
    return doc;
  }

  async remove(id: string): Promise<void> {
    const doc = await this.exportModel.findByIdAndDelete(id).exec();
    if (!doc) throw new NotFoundException('Warehouse export not found');
  }
}
