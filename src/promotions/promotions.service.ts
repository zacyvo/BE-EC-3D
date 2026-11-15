import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Promotion, PromotionDocument, DiscountType, CouponItem,
  DEFAULT_FREE_SHIP_CODE, DEFAULT_FREE_SHIP_SYSTEM_KEY,
} from './schemas/promotion.schema';
import { computeShippingFee } from '../orders/shipping-fee.util';
import {
  CreatePromotionDto, UpdatePromotionDto, AssignPromotionDto,
  CreateCouponItemDto, UpdateCouponItemDto,
  ValidateCouponsDto, QueryPromotionsDto,
} from './dto/promotion.dto';

/** Final total must stay at or above this amount after all discounts (VND) */
const FLOOR_AMOUNT = 50_000;

/** 'order' = takes money off the goods; 'shipping' = waives (part of) the shipping fee. */
export type AppliedCouponKind = 'order' | 'shipping';

export interface AppliedCoupon {
  code: string;
  name: string;       // program name
  discountAmount: number;
  kind: AppliedCouponKind;
}

export interface RejectedCoupon {
  code: string;
  reason: string;
}

export interface ValidateResult {
  appliedCoupons: AppliedCoupon[];
  /** Codes that could not be applied, with a customer-facing reason. */
  rejectedCoupons: RejectedCoupon[];
  /** Discount on the goods only (coupons of kind 'order'). */
  totalDiscount: number;
  /** Goods total after `totalDiscount` (shipping not included). */
  finalTotal: number;
  /** Shipping fee the code(s) waive — subtract it from the shipping fee. */
  shippingDiscount: number;
  /** Shipping fee the free-shipping code was priced against (null when unknown: no address yet). */
  shippingFee: number | null;
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
export class PromotionsService implements OnModuleInit {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<PromotionDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureDefaultFreeShipCoupon();
    } catch (err) {
      // Never block boot over the seed — the shop can still create the code by hand.
      this.logger.warn(`Could not seed default ${DEFAULT_FREE_SHIP_CODE} coupon: ${(err as Error).message}`);
    }
  }

  /**
   * Seed the built-in "Miễn phí vận chuyển" program holding the FREE_SHIP code, once per database.
   * Created switched OFF (isActive=false) so deploying never starts waiving shipping on its own —
   * the shop turns it on (and tunes min order / limits) in admin → Khuyến mãi.
   * Skipped when the program was already seeded (systemKey, even if the shop later edited it) or a
   * FREE_SHIP code already exists in another program. Upsert + unique sparse index on systemKey
   * keep concurrent boots from creating it twice.
   */
  async ensureDefaultFreeShipCoupon(): Promise<'created' | 'exists'> {
    const already = await this.promotionModel.exists({
      $or: [{ systemKey: DEFAULT_FREE_SHIP_SYSTEM_KEY }, { 'coupons.code': DEFAULT_FREE_SHIP_CODE }],
    });
    if (already) return 'exists';

    const now = new Date();
    try {
      const res = await this.promotionModel.updateOne(
        { systemKey: DEFAULT_FREE_SHIP_SYSTEM_KEY },
        {
          $setOnInsert: {
            systemKey: DEFAULT_FREE_SHIP_SYSTEM_KEY,
            name: 'Miễn phí vận chuyển',
            description: 'Nhập mã FREE_SHIP khi thanh toán để được miễn phí vận chuyển.',
            startDate: now,
            endDate: new Date('2099-12-31T16:59:59.000Z'),
            isActive: false,
            assignedToAll: true,
            assignedUsers: [],
            coupons: [
              {
                _id: new Types.ObjectId(),
                code: DEFAULT_FREE_SHIP_CODE,
                type: DiscountType.FREE_SHIPPING,
                value: 0,
                minOrderValue: 0,
                maxDiscountAmount: 0,
                totalUsageLimit: 0,
                perUserUsageLimit: 1,
                totalUsedCount: 0,
                usageRecords: [],
              },
            ],
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount) {
        this.logger.log(`Seeded default ${DEFAULT_FREE_SHIP_CODE} coupon (inactive)`);
        return 'created';
      }
      return 'exists';
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return 'exists'; // another instance won the race
      throw err;
    }
  }

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
    if (promo.systemKey) {
      // Deleting it would only make the boot seed recreate it — switch it off instead.
      throw new BadRequestException('Đây là chương trình mặc định của hệ thống — hãy tắt "Kích hoạt" thay vì xoá');
    }
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

  /** Atomically grant one user access to a program's coupons (same `assignedUsers`
   * mechanism as assign(), but with $addToSet so concurrent callers can't lose an update
   * and repeating it is a no-op). Returns false if the program does not exist. */
  async assignUserToProgram(programId: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(programId) || !Types.ObjectId.isValid(userId)) return false;
    const res = await this.promotionModel.updateOne(
      { _id: new Types.ObjectId(programId) },
      { $addToSet: { assignedUsers: new Types.ObjectId(userId) } },
    );
    return res.matchedCount === 1;
  }

  // ─── Admin: Coupon CRUD (within a program) ────────────────────────────────

  async addCoupon(programId: string, dto: CreateCouponItemDto): Promise<PromotionDocument> {
    const code = dto.code.toUpperCase().trim();
    if (!code) throw new BadRequestException('Mã giảm giá không được để trống');

    // Ensure code is globally unique across all programs
    const conflict = await this.promotionModel.findOne({ 'coupons.code': code });
    if (conflict) throw new ConflictException(`Mã "${code}" đã tồn tại trong chương trình khác`);

    const values = this.normalizeCouponValues(dto.type, dto.value, dto.maxDiscountAmount ?? 0);

    const promo = await this.findById(programId);
    promo.coupons.push({
      code,
      type: dto.type,
      ...values,
      minOrderValue: dto.minOrderValue ?? 0,
      totalUsageLimit: dto.totalUsageLimit ?? 0,
      perUserUsageLimit: dto.perUserUsageLimit ?? 1,
      totalUsedCount: 0,
      usageRecords: [],
    } as any);
    return promo.save();
  }

  /** Type-specific rules: percentage ≤ 100; fixed has no cap; free_shipping ignores `value`. */
  private normalizeCouponValues(
    type: DiscountType,
    value: number,
    maxDiscountAmount: number,
  ): { value: number; maxDiscountAmount: number } {
    switch (type) {
      case DiscountType.PERCENTAGE:
        if (value > 100) throw new BadRequestException('Phần trăm giảm giá không thể vượt quá 100%');
        return { value, maxDiscountAmount };
      case DiscountType.FREE_SHIPPING:
        return { value: 0, maxDiscountAmount };
      default:
        return { value, maxDiscountAmount: 0 };
    }
  }

  async updateCoupon(
    programId: string,
    couponId: string,
    dto: UpdateCouponItemDto,
  ): Promise<PromotionDocument> {
    const promo = await this.findById(programId);
    const coupon = promo.coupons.find((c) => c._id.toString() === couponId);
    if (!coupon) throw new NotFoundException('Không tìm thấy mã giảm giá');

    const type = dto.type ?? coupon.type;
    const values = this.normalizeCouponValues(
      type,
      dto.value ?? coupon.value,
      dto.maxDiscountAmount ?? coupon.maxDiscountAmount,
    );
    coupon.type = type;
    coupon.value = values.value;
    coupon.maxDiscountAmount = values.maxDiscountAmount;
    if (dto.minOrderValue !== undefined) coupon.minOrderValue = dto.minOrderValue;
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
   * Validate coupon codes against an order.
   * - 'order' coupons (percentage / fixed) stack on the goods total, in the given order. Floor rule:
   *   the goods total after all of them must stay >= 50,000 VND — a coupon that would break it is rejected.
   * - 'shipping' coupons (free_shipping) waive the shipping fee (whole fee, or up to maxDiscountAmount);
   *   at most one per order, and they need a known shipping fee (from `opts.shippingFee`, else `dto.city`).
   * Every code that isn't applied is returned in `rejectedCoupons` with a customer-facing reason.
   */
  async validateCoupons(
    userId: string,
    dto: ValidateCouponsDto,
    opts: { shippingFee?: number } = {},
  ): Promise<ValidateResult> {
    const { orderTotal } = dto;
    const shippingFee =
      opts.shippingFee !== undefined ? opts.shippingFee : dto.city?.trim() ? computeShippingFee(dto.city) : null;
    const now = new Date();
    const userOid = new Types.ObjectId(userId);

    const applied: AppliedCoupon[] = [];
    const rejected: RejectedCoupon[] = [];
    let runningTotal = orderTotal;
    let shippingDiscount = 0;

    const codes = [...new Set(dto.couponCodes.map((c) => c.toUpperCase().trim()).filter(Boolean))];
    for (const code of codes) {
      const reject = (reason: string) => rejected.push({ code, reason });

      // Find the accessible program containing this code
      const program = await this.promotionModel.findOne({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [{ assignedToAll: true }, { assignedUsers: userOid }],
        'coupons.code': code,
      });
      const coupon = program?.coupons.find((c) => c.code === code);
      if (!program || !coupon) {
        reject('Mã không tồn tại, đã hết hạn hoặc không áp dụng cho tài khoản của bạn');
        continue;
      }

      // Usage limits
      if (coupon.totalUsageLimit > 0 && coupon.totalUsedCount >= coupon.totalUsageLimit) {
        reject('Mã đã hết lượt sử dụng');
        continue;
      }
      const userRecord = coupon.usageRecords.find((r) => r.userId.toString() === userId);
      if (userRecord && userRecord.count >= coupon.perUserUsageLimit) {
        reject('Bạn đã dùng hết lượt của mã này');
        continue;
      }

      // Minimum order requirement (against the original goods total, not the running one)
      if (orderTotal < coupon.minOrderValue) {
        reject(`Đơn hàng tối thiểu ${coupon.minOrderValue.toLocaleString('vi-VN')}₫ để dùng mã này`);
        continue;
      }

      if (coupon.type === DiscountType.FREE_SHIPPING) {
        if (applied.some((a) => a.kind === 'shipping')) {
          reject('Mỗi đơn chỉ áp dụng 1 mã miễn phí vận chuyển');
          continue;
        }
        if (shippingFee === null) {
          reject('Chọn địa chỉ giao hàng để áp dụng mã miễn phí vận chuyển');
          continue;
        }
        if (shippingFee <= 0) {
          reject('Đơn hàng này không có phí vận chuyển');
          continue;
        }
        const amount = this.freeShippingAmount(coupon, shippingFee);
        shippingDiscount = amount;
        applied.push({ code, name: program.name, discountAmount: amount, kind: 'shipping' });
        continue;
      }

      // Goods discount
      let discountAmount: number;
      if (coupon.type === DiscountType.PERCENTAGE) {
        discountAmount = Math.round((runningTotal * coupon.value) / 100);
        if (coupon.maxDiscountAmount > 0) {
          discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
        }
      } else {
        discountAmount = coupon.value;
      }

      // Floor rule
      const afterDiscount = runningTotal - discountAmount;
      if (afterDiscount < FLOOR_AMOUNT) {
        reject(`Giá trị đơn sau giảm phải còn tối thiểu ${FLOOR_AMOUNT.toLocaleString('vi-VN')}₫`);
        continue;
      }

      runningTotal = afterDiscount;
      applied.push({ code, name: program.name, discountAmount, kind: 'order' });
    }

    return {
      appliedCoupons: applied,
      rejectedCoupons: rejected,
      totalDiscount: orderTotal - runningTotal,
      finalTotal: runningTotal,
      shippingDiscount,
      shippingFee,
    };
  }

  /** Shipping fee a free-shipping coupon waives: the whole fee, or up to its cap. */
  private freeShippingAmount(coupon: Pick<CouponItem, 'maxDiscountAmount'>, shippingFee: number): number {
    const fee = Math.max(0, shippingFee);
    return coupon.maxDiscountAmount > 0 ? Math.min(fee, coupon.maxDiscountAmount) : fee;
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


