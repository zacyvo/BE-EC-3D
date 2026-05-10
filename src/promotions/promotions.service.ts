import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Promotion, PromotionDocument, DiscountType,
} from './schemas/promotion.schema';
import {
  CreatePromotionDto, UpdatePromotionDto, AssignPromotionDto,
  CreateCouponItemDto, UpdateCouponItemDto,
  ValidateCouponsDto, QueryPromotionsDto,
} from './dto/promotion.dto';

/** Final total must stay at or above this amount after all discounts (VND) */
const FLOOR_AMOUNT = 50_000;

export interface AppliedCoupon {
  code: string;
  name: string;       // program name
  discountAmount: number;
}

export interface ValidateResult {
  appliedCoupons: AppliedCoupon[];
  totalDiscount: number;
  finalTotal: number;
}

/** Flat coupon shape returned to user-facing endpoints */
export interface UserCoupon {
  _id: string;
  code: string;
  programId: string;
  programName: string;
  description?: string;
  type: DiscountType;
  value: number;
  minOrderValue: number;
  maxDiscountAmount: number;
  perUserUsageLimit: number;
  startDate: Date;
  endDate: Date;
}

@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<PromotionDocument>,
  ) {}

  // ─── Admin: Program CRUD ──────────────────────────────────────────────────

  async create(dto: CreatePromotionDto, staffId: string): Promise<PromotionDocument> {
    if (new Date(dto.endDate) <= new Date(dto.startDate)) {
      throw new BadRequestException('Ngày kết thúc phải sau ngày bắt đầu');
    }
    return this.promotionModel.create({
      ...dto,
      assignedUsers: (dto.assignedUsers ?? []).map((id) => new Types.ObjectId(id)),
      createdBy: new Types.ObjectId(staffId),
    });
  }

  async findAll(query: QueryPromotionsDto): Promise<{ data: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const { search, isActive, page = 1, limit = 20 } = query;
    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (isActive !== undefined) filter.isActive = isActive;

    const skip = (page - 1) * limit;
    const [rawData, total] = await Promise.all([
      this.promotionModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.promotionModel.countDocuments(filter),
    ]);

    // Strip usageRecords from coupons — not needed in list view
    const data = rawData.map((p) => ({
      ...p,
      coupons: (p.coupons ?? []).map(({ usageRecords: _ur, ...c }) => c),
    }));

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: string): Promise<PromotionDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Không tìm thấy chương trình');
    const promo = await this.promotionModel.findById(id);
    if (!promo) throw new NotFoundException('Không tìm thấy chương trình');
    return promo;
  }

  /** Return program data without usageRecords (safe for admin detail view) */
  async findByIdSafe(id: string) {
    const promo = await this.findById(id);
    const obj = promo.toObject() as Record<string, unknown> & {
      coupons: (Record<string, unknown> & { usageRecords?: unknown })[];
    };
    return {
      ...obj,
      coupons: (obj.coupons ?? []).map(({ usageRecords: _ur, ...c }) => c),
    };
  }

  async update(id: string, dto: UpdatePromotionDto): Promise<PromotionDocument> {
    const promo = await this.findById(id);
    if (dto.startDate || dto.endDate) {
      const start = dto.startDate ? new Date(dto.startDate) : promo.startDate;
      const end = dto.endDate ? new Date(dto.endDate) : promo.endDate;
      if (end <= start) throw new BadRequestException('Ngày kết thúc phải sau ngày bắt đầu');
    }
    Object.assign(promo, dto);
    return promo.save();
  }

  async remove(id: string): Promise<void> {
    const promo = await this.findById(id);
    await promo.deleteOne();
  }

  async assign(id: string, dto: AssignPromotionDto): Promise<PromotionDocument> {
    const promo = await this.findById(id);

    if (dto.assignToAll !== undefined) promo.assignedToAll = dto.assignToAll;

    if (dto.addUserIds?.length) {
      const toAdd = dto.addUserIds.map((uid) => new Types.ObjectId(uid));
      const existing = new Set(promo.assignedUsers.map((u) => u.toString()));
      for (const uid of toAdd) {
        if (!existing.has(uid.toString())) promo.assignedUsers.push(uid);
      }
    }
    if (dto.removeUserIds?.length) {
      const toRemove = new Set(dto.removeUserIds);
      promo.assignedUsers = promo.assignedUsers.filter(
        (uid) => !toRemove.has(uid.toString()),
      );
    }

    return promo.save();
  }

  // ─── Admin: Coupon CRUD (within a program) ────────────────────────────────

  async addCoupon(programId: string, dto: CreateCouponItemDto): Promise<PromotionDocument> {
    const code = dto.code.toUpperCase().trim();

    // Ensure code is globally unique across all programs
    const conflict = await this.promotionModel.findOne({ 'coupons.code': code });
    if (conflict) throw new ConflictException(`Mã "${code}" đã tồn tại trong chương trình khác`);

    if (dto.type === DiscountType.PERCENTAGE && dto.value > 100) {
      throw new BadRequestException('Phần trăm giảm giá không thể vượt quá 100%');
    }

    const promo = await this.findById(programId);
    promo.coupons.push({
      code,
      type: dto.type,
      value: dto.value,
      minOrderValue: dto.minOrderValue ?? 0,
      maxDiscountAmount: dto.maxDiscountAmount ?? 0,
      totalUsageLimit: dto.totalUsageLimit ?? 0,
      perUserUsageLimit: dto.perUserUsageLimit ?? 1,
      totalUsedCount: 0,
      usageRecords: [],
    } as any);
    return promo.save();
  }

  async updateCoupon(
    programId: string,
    couponId: string,
    dto: UpdateCouponItemDto,
  ): Promise<PromotionDocument> {
    const promo = await this.findById(programId);
    const coupon = promo.coupons.find((c) => c._id.toString() === couponId);
    if (!coupon) throw new NotFoundException('Không tìm thấy mã giảm giá');

    if (dto.type !== undefined) coupon.type = dto.type;
    if (dto.value !== undefined) {
      if (coupon.type === DiscountType.PERCENTAGE && dto.value > 100) {
        throw new BadRequestException('Phần trăm giảm giá không thể vượt quá 100%');
      }
      coupon.value = dto.value;
    }
    if (dto.minOrderValue !== undefined) coupon.minOrderValue = dto.minOrderValue;
    if (dto.maxDiscountAmount !== undefined) coupon.maxDiscountAmount = dto.maxDiscountAmount;
    if (dto.totalUsageLimit !== undefined) coupon.totalUsageLimit = dto.totalUsageLimit;
    if (dto.perUserUsageLimit !== undefined) coupon.perUserUsageLimit = dto.perUserUsageLimit;

    return promo.save();
  }

  async removeCoupon(programId: string, couponId: string): Promise<PromotionDocument> {
    const promo = await this.findById(programId);
    const idx = promo.coupons.findIndex((c) => c._id.toString() === couponId);
    if (idx === -1) throw new NotFoundException('Không tìm thấy mã giảm giá');
    promo.coupons.splice(idx, 1);
    return promo.save();
  }

  // ─── User-facing ──────────────────────────────────────────────────────────

  /** Return flat list of all coupons from programs accessible by this user */
  async getMyCoupons(userId: string): Promise<UserCoupon[]> {
    const now = new Date();
    const userOid = new Types.ObjectId(userId);

    const programs = await this.promotionModel
      .find({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [{ assignedToAll: true }, { assignedUsers: userOid }],
      })
      .sort({ endDate: 1 })
      .lean();

    const result: UserCoupon[] = [];
    for (const prog of programs) {
      for (const c of prog.coupons ?? []) {
        // Check if user still has usage quota for this coupon
        const userRecord = (c.usageRecords ?? []).find(
          (r) => r.userId.toString() === userId,
        );
        if (userRecord && userRecord.count >= c.perUserUsageLimit) continue;
        if (c.totalUsageLimit > 0 && c.totalUsedCount >= c.totalUsageLimit) continue;

        result.push({
          _id: c._id.toString(),
          code: c.code,
          programId: prog._id.toString(),
          programName: prog.name,
          description: prog.description,
          type: c.type,
          value: c.value,
          minOrderValue: c.minOrderValue,
          maxDiscountAmount: c.maxDiscountAmount,
          perUserUsageLimit: c.perUserUsageLimit,
          startDate: prog.startDate,
          endDate: prog.endDate,
        });
      }
    }
    return result;
  }

  /**
   * Validate coupon codes against an order total.
   * Floor rule: final total after all discounts must remain >= 50,000 VND.
   * Coupons that would violate the floor are silently skipped.
   */
  async validateCoupons(userId: string, dto: ValidateCouponsDto): Promise<ValidateResult> {
    const { couponCodes, orderTotal } = dto;
    const now = new Date();
    const userOid = new Types.ObjectId(userId);

    const applied: AppliedCoupon[] = [];
    let runningTotal = orderTotal;

    for (const rawCode of couponCodes) {
      const code = rawCode.toUpperCase().trim();

      // Find the accessible program containing this code
      const program = await this.promotionModel.findOne({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [{ assignedToAll: true }, { assignedUsers: userOid }],
        'coupons.code': code,
      });
      if (!program) continue;

      const coupon = program.coupons.find((c) => c.code === code);
      if (!coupon) continue;

      // Check usage limits
      if (coupon.totalUsageLimit > 0 && coupon.totalUsedCount >= coupon.totalUsageLimit) continue;
      const userRecord = coupon.usageRecords.find((r) => r.userId.toString() === userId);
      if (userRecord && userRecord.count >= coupon.perUserUsageLimit) continue;

      // Check minimum order requirement (against original total, not running)
      if (orderTotal < coupon.minOrderValue) continue;

      // Calculate discount
      let discountAmount: number;
      if (coupon.type === DiscountType.PERCENTAGE) {
        discountAmount = Math.round((runningTotal * coupon.value) / 100);
        if (coupon.maxDiscountAmount > 0) {
          discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
        }
      } else {
        discountAmount = coupon.value;
      }

      // Floor rule — silently skip if result would go below threshold
      const afterDiscount = runningTotal - discountAmount;
      if (afterDiscount < FLOOR_AMOUNT) continue;

      runningTotal = afterDiscount;
      applied.push({ code, name: program.name, discountAmount });
    }

    return {
      appliedCoupons: applied,
      totalDiscount: orderTotal - runningTotal,
      finalTotal: runningTotal,
    };
  }

  /**
   * Mark coupons as used after an order is confirmed.
   * Called by OrdersService after successful order creation.
   */
  async markUsed(userId: string, couponCodes: string[]): Promise<void> {
    if (!couponCodes.length) return;
    const userOid = new Types.ObjectId(userId);

    for (const rawCode of couponCodes) {
      const code = rawCode.toUpperCase().trim();
      const program = await this.promotionModel.findOne({ 'coupons.code': code });
      if (!program) continue;

      const coupon = program.coupons.find((c) => c.code === code);
      if (!coupon) continue;

      coupon.totalUsedCount += 1;
      const record = coupon.usageRecords.find((r) => r.userId.toString() === userId);
      if (record) {
        record.count += 1;
      } else {
        coupon.usageRecords.push({ userId: userOid, count: 1 } as any);
      }
      await program.save();
    }
  }
}


