import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Invoice, InvoiceDocument } from './schemas/invoice.schema';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';

@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name) private readonly invoiceModel: Model<InvoiceDocument>,
  ) {}

  async create(dto: CreateInvoiceDto, staffId: string): Promise<InvoiceDocument> {
    return this.invoiceModel.create({
      ...dto,
      date: new Date(dto.date),
      images: dto.images ?? [],
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(staffId),
    });
  }

  async findAll(params: {
    page: number;
    limit: number;
    category?: string;
    source?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
  }) {
    const { page, limit, category, source, search, fromDate, toDate } = params;
    const filter: Record<string, unknown> = {};

    if (category) filter.category = category;
    if (source) filter.source = source;
    if (search) filter.title = { $regex: search, $options: 'i' };
    if (fromDate || toDate) {
      filter.date = {};
      if (fromDate) (filter.date as Record<string, unknown>).$gte = new Date(fromDate);
      if (toDate) (filter.date as Record<string, unknown>).$lte = new Date(toDate);
    }

    const [data, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .lean(),
      this.invoiceModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: string): Promise<InvoiceDocument> {
    const invoice = await this.invoiceModel
      .findById(id)
      .populate('createdBy', 'name email')
      .exec();
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async update(id: string, dto: UpdateInvoiceDto): Promise<InvoiceDocument> {
    const update: Record<string, unknown> = { ...dto };
    if (dto.date) update.date = new Date(dto.date);

    const invoice = await this.invoiceModel
      .findByIdAndUpdate(id, update, { new: true })
      .populate('createdBy', 'name email')
      .exec();
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async remove(id: string): Promise<void> {
    const result = await this.invoiceModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Invoice not found');
  }

  async getStats(year?: number) {
    const targetYear = year ?? new Date().getFullYear();
    const start = new Date(`${targetYear}-01-01`);
    const end = new Date(`${targetYear + 1}-01-01`);

    const [byCategory, bySource, monthly] = await Promise.all([
      this.invoiceModel.aggregate([
        { $match: { date: { $gte: start, $lt: end } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      this.invoiceModel.aggregate([
        { $match: { date: { $gte: start, $lt: end } } },
        { $group: { _id: '$source', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      this.invoiceModel.aggregate([
        { $match: { date: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: { $month: '$date' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const grandTotal = await this.invoiceModel.aggregate([
      { $match: { date: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    return {
      year: targetYear,
      grandTotal: grandTotal[0]?.total ?? 0,
      byCategory,
      bySource,
      monthly,
    };
  }
}
