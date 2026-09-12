import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FilamentImport, FilamentImportDocument,
  FilamentUnit, FilamentUnitDocument,
  FilamentStockAdjustment, FilamentStockAdjustmentDocument,
  FilamentUnitStatus, FilamentType, FilamentColor,
} from './schemas/filament.schema';
import { CreateFilamentImportDto, ExportFilamentDto, AdjustFilamentStockDto } from './dto/filament.dto';
import { InvoicesService } from '../invoices/invoices.service';
import { InvoiceCategory, InvoiceSource } from '../invoices/schemas/invoice.schema';

const TYPE_LABEL: Record<FilamentType, string> = {
  [FilamentType.PETG_BASIC]: 'PETG-Basic',
  [FilamentType.PLA_MATTE]: 'PLA Matte',
  [FilamentType.PLA_SILK]: 'PLA Silk',
};

const COLOR_LABEL: Record<FilamentColor, string> = {
  [FilamentColor.WHITE]: 'Trắng',
  [FilamentColor.BLACK]: 'Đen',
  [FilamentColor.GRAY]: 'Xám',
  [FilamentColor.SILVER]: 'Bạc',
  [FilamentColor.RED]: 'Đỏ',
  [FilamentColor.ORANGE]: 'Cam',
  [FilamentColor.YELLOW]: 'Vàng',
  [FilamentColor.LIME]: 'Vàng chanh',
  [FilamentColor.GREEN]: 'Xanh lá',
  [FilamentColor.DARK_GREEN]: 'Xanh lá đậm',
  [FilamentColor.TEAL]: 'Xanh ngọc',
  [FilamentColor.BLUE]: 'Xanh dương',
  [FilamentColor.LIGHT_BLUE]: 'Xanh dương nhạt',
  [FilamentColor.NAVY]: 'Xanh navy',
  [FilamentColor.PURPLE]: 'Tím',
  [FilamentColor.LAVENDER]: 'Tím pastel',
  [FilamentColor.PINK]: 'Hồng',
  [FilamentColor.PASTEL_PINK]: 'Hồng pastel',
  [FilamentColor.BROWN]: 'Nâu',
  [FilamentColor.BEIGE]: 'Be',
  [FilamentColor.GOLD]: 'Vàng gold',
  [FilamentColor.BRONZE]: 'Đồng',
  [FilamentColor.CLEAR]: 'Trong suốt',
  [FilamentColor.OLIVE]: 'Rêu',
};

interface ProcessedItem {
  type: FilamentType;
  color: FilamentColor;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

@Injectable()
export class FilamentsService {
  constructor(
    @InjectModel(FilamentImport.name)
    private readonly importModel: Model<FilamentImportDocument>,
    @InjectModel(FilamentUnit.name)
    private readonly unitModel: Model<FilamentUnitDocument>,
    @InjectModel(FilamentStockAdjustment.name)
    private readonly adjustmentModel: Model<FilamentStockAdjustmentDocument>,
    private readonly invoicesService: InvoicesService,
  ) {}

  /**
   * Nếu tất cả các loại đều đã điền giá nhập -> tính tổng từ items.
   * Nếu có loại chưa điền giá -> bắt buộc dto.totalAmount, phần còn lại sau khi
   * trừ các loại đã có giá được chia đều theo số lượng cho các loại còn thiếu giá.
   */
  private resolveItemPricing(dto: CreateFilamentImportDto): {
    items: ProcessedItem[];
    totalAmount: number;
  } {
    const unpriced = dto.items.filter((i) => i.unitPrice == null);

    if (unpriced.length === 0) {
      const items = dto.items.map((i) => ({
        type: i.type,
        color: i.color,
        quantity: i.quantity,
        unitPrice: i.unitPrice as number,
        totalPrice: (i.unitPrice as number) * i.quantity,
      }));
      return { items, totalAmount: items.reduce((s, i) => s + i.totalPrice, 0) };
    }

    if (dto.totalAmount == null) {
      throw new BadRequestException(
        'Chưa điền đủ giá nhập từng loại — vui lòng nhập giá tổng hóa đơn để tính giá trung bình',
      );
    }

    const pricedSubtotal = dto.items
      .filter((i) => i.unitPrice != null)
      .reduce((s, i) => s + (i.unitPrice as number) * i.quantity, 0);
    const unpricedQty = unpriced.reduce((s, i) => s + i.quantity, 0);
    const remaining = dto.totalAmount - pricedSubtotal;

    if (remaining < 0) {
      throw new BadRequestException('Giá tổng hóa đơn nhỏ hơn tổng giá các loại đã điền giá riêng');
    }

    const avgUnitPrice = Math.round(remaining / unpricedQty);
    const items = dto.items.map((i) => {
      const unitPrice = i.unitPrice ?? avgUnitPrice;
      return { type: i.type, color: i.color, quantity: i.quantity, unitPrice, totalPrice: unitPrice * i.quantity };
    });

    return { items, totalAmount: dto.totalAmount };
  }

  async createImport(dto: CreateFilamentImportDto, staffId: string): Promise<FilamentImportDocument> {
    const { items, totalAmount } = this.resolveItemPricing(dto);
    const importDate = new Date(dto.date);

    const importDoc = await this.importModel.create({
      items,
      totalAmount,
      date: importDate,
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(staffId),
    });

    const unitDocs = items.flatMap((item) =>
      Array.from({ length: item.quantity }, () => ({
        type: item.type,
        color: item.color,
        unitPrice: item.unitPrice,
        status: FilamentUnitStatus.NEW,
        importId: importDoc._id,
      })),
    );
    if (unitDocs.length) await this.unitModel.insertMany(unitDocs);

    // Tự động chuyển phiếu nhập thành 1 hóa đơn trong mục Hóa đơn
    const summary = items
      .map((i) => `${TYPE_LABEL[i.type]} ${COLOR_LABEL[i.color]} x${i.quantity}`)
      .join(', ');
    const invoice = await this.invoicesService.create(
      {
        title: `Nhập Filament - ${summary}`,
        category: InvoiceCategory.MATERIAL_IMPORT,
        amount: totalAmount,
        source: InvoiceSource.DIRECT,
        date: dto.date,
        note: dto.note || 'Tự động tạo từ phiếu nhập filament',
      },
      staffId,
    );

    importDoc.invoiceId = invoice._id;
    await importDoc.save();

    return importDoc;
  }

  async findImports(params: { page: number; limit: number; fromDate?: string; toDate?: string }) {
    const { page, limit, fromDate, toDate } = params;
    const filter: Record<string, unknown> = {};

    if (fromDate || toDate) {
      filter.date = {};
      if (fromDate) (filter.date as Record<string, unknown>).$gte = new Date(fromDate);
      if (toDate) (filter.date as Record<string, unknown>).$lte = new Date(toDate);
    }

    const [data, total] = await Promise.all([
      this.importModel
        .find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .lean(),
      this.importModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findUnits(params: { page: number; limit: number; type?: string; color?: string; status?: string }) {
    const { page, limit, type, color, status } = params;
    const filter: Record<string, unknown> = {};
    if (type) filter.type = type;
    if (color) filter.color = color;
    if (status) filter.status = status;

    const [data, total] = await Promise.all([
      this.unitModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('exportedBy', 'name email')
        .lean(),
      this.unitModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getStock() {
    return this.unitModel.aggregate([
      { $group: { _id: { type: '$type', color: '$color', status: '$status' }, count: { $sum: 1 } } },
    ]);
  }

  async exportFilament(dto: ExportFilamentDto, staffId: string) {
    const available = await this.unitModel
      .find({ type: dto.type, color: dto.color, status: FilamentUnitStatus.NEW })
      .sort({ createdAt: 1 })
      .limit(dto.quantity);

    if (available.length < dto.quantity) {
      throw new BadRequestException(
        `Chỉ còn ${available.length} cuộn ${TYPE_LABEL[dto.type]} màu ${COLOR_LABEL[dto.color]} ở trạng thái Mới`,
      );
    }

    const ids = available.map((u) => u._id);
    const now = new Date();
    await this.unitModel.updateMany(
      { _id: { $in: ids } },
      {
        status: FilamentUnitStatus.IN_USE,
        exportedAt: now,
        exportedBy: new Types.ObjectId(staffId),
        ...(dto.note ? { note: dto.note } : {}),
      },
    );

    return this.unitModel.find({ _id: { $in: ids } }).populate('exportedBy', 'name email').lean();
  }

  /**
   * Kiểm kê: đối chiếu số lượng thực đếm với số lượng hệ thống cho 1 tổ hợp
   * (loại, màu, trạng thái) rồi tự thêm/bớt cuộn cho khớp. Không liên quan giá tiền —
   * cuộn được tạo thêm có unitPrice = 0 và không gắn với phiếu nhập/hóa đơn nào.
   */
  async adjustStock(dto: AdjustFilamentStockDto, staffId: string): Promise<FilamentStockAdjustmentDocument> {
    const filter = { type: dto.type, color: dto.color, status: dto.status };
    const systemQtyBefore = await this.unitModel.countDocuments(filter);
    const diff = dto.actualQuantity - systemQtyBefore;

    if (diff > 0) {
      const now = new Date();
      const note = dto.note || 'Điều chỉnh từ kiểm kê';
      const extra =
        dto.status === FilamentUnitStatus.IN_USE
          ? { exportedAt: now, exportedBy: new Types.ObjectId(staffId) }
          : dto.status === FilamentUnitStatus.DEPLETED
            ? { depletedAt: now }
            : {};
      const unitDocs = Array.from({ length: diff }, () => ({
        type: dto.type,
        color: dto.color,
        unitPrice: 0,
        status: dto.status,
        note,
        ...extra,
      }));
      await this.unitModel.insertMany(unitDocs);
    } else if (diff < 0) {
      const excess = await this.unitModel
        .find(filter)
        .sort({ createdAt: 1 })
        .limit(-diff)
        .select('_id');
      await this.unitModel.deleteMany({ _id: { $in: excess.map((u) => u._id) } });
    }

    return this.adjustmentModel.create({
      type: dto.type,
      color: dto.color,
      status: dto.status,
      systemQtyBefore,
      actualQty: dto.actualQuantity,
      diff,
      note: dto.note ?? '',
      createdBy: new Types.ObjectId(staffId),
    });
  }

  async findAdjustments(params: { page: number; limit: number }) {
    const { page, limit } = params;

    const [data, total] = await Promise.all([
      this.adjustmentModel
        .find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .lean(),
      this.adjustmentModel.countDocuments(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async depleteUnit(id: string): Promise<FilamentUnitDocument> {
    const unit = await this.unitModel.findById(id);
    if (!unit) throw new NotFoundException('Không tìm thấy filament');
    if (unit.status === FilamentUnitStatus.DEPLETED) {
      throw new BadRequestException('Filament này đã ở trạng thái Hết');
    }
    unit.status = FilamentUnitStatus.DEPLETED;
    unit.depletedAt = new Date();
    await unit.save();
    return unit;
  }

  async getStats(year?: number) {
    const targetYear = year ?? new Date().getFullYear();
    const start = new Date(`${targetYear}-01-01`);
    const end = new Date(`${targetYear + 1}-01-01`);

    const [monthlyImports, monthlyExports, stockByStatus] = await Promise.all([
      this.importModel.aggregate([
        { $match: { date: { $gte: start, $lt: end } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: { month: { $month: '$date' }, type: '$items.type' },
            quantity: { $sum: '$items.quantity' },
            cost: { $sum: '$items.totalPrice' },
          },
        },
      ]),
      this.unitModel.aggregate([
        { $match: { exportedAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: { month: { $month: '$exportedAt' }, type: '$type' },
            quantity: { $sum: 1 },
          },
        },
      ]),
      this.unitModel.aggregate([
        { $group: { _id: { type: '$type', color: '$color', status: '$status' }, count: { $sum: 1 } } },
      ]),
    ]);

    return { year: targetYear, monthlyImports, monthlyExports, stockByStatus };
  }
}
