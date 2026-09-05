import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { Order, SOLD_ORDER_STATUSES } from '../orders/schemas/order.schema';
import { Product } from '../products/schemas/product.schema';
import { User } from '../users/schemas/user.schema';
import { ExternalRevenue, ExternalSource } from '../external-revenue/schemas/external-revenue.schema';

const MONTH_LABELS = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12'];

// Fixed, non-cycled order for the "revenue by source" breakdown — WEBSITE is
// computed live from Order data, the rest come from manually-entered ExternalRevenue.
const EXTERNAL_SOURCES = Object.values(ExternalSource);
const ALL_SOURCES = ['WEBSITE', ...EXTERNAL_SOURCES] as const;

@Controller('admin/analytics')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class AnalyticsController {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<any>,
    @InjectModel(Product.name) private productModel: Model<any>,
    @InjectModel(User.name) private userModel: Model<any>,
    @InjectModel(ExternalRevenue.name) private externalRevenueModel: Model<any>,
  ) {}

  @Get('dashboard')
  async getDashboard() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-based

    const startOfYear = new Date(currentYear, 0, 1);
    const startOfMonth = new Date(currentYear, currentMonth, 1);
    const startOfNextMonth = new Date(currentYear, currentMonth + 1, 1);

    const [
      totalOrders,
      totalProducts,
      totalUsers,
      recentOrders,
      topProductsRaw,
      revenueAggregate,
      monthlyOrdersRaw,
      monthlyRevenueRaw,
      monthlyUsersRaw,
      currentMonthOrders,
      currentMonthRevenue,
      currentMonthUsers,
      ordersByStatus,
    ] = await Promise.all([
      this.orderModel.countDocuments({ isDeleted: { $ne: true } }).exec(),
      this.productModel.countDocuments().exec(),
      this.userModel.countDocuments().exec(),

      this.orderModel
        .find({ isDeleted: { $ne: true } })
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean()
        .exec(),

      // Top selling products: computed live from actual order line items
      // (Product.orderCount is a stale/legacy counter that is never incremented
      // when real orders are placed, so it no longer reflects real sales).
      this.orderModel.aggregate([
        { $match: { status: { $in: SOLD_ORDER_STATUSES }, isDeleted: { $ne: true } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.productId',
            orderCount: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: '_p',
          },
        },
        { $addFields: { _p: { $arrayElemAt: ['$_p', 0] } } },
        { $match: { '_p': { $ne: null }, '_p.isDeleted': { $ne: true } } },
        { $sort: { orderCount: -1 } },
        { $limit: 6 },
        {
          $project: {
            _id: '$_p._id',
            name: '$_p.name',
            slug: '$_p.slug',
            images: '$_p.images',
            finalPrice: '$_p.finalPrice',
            viewCount: '$_p.viewCount',
            orderCount: 1,
          },
        },
      ]),

      // All-time revenue (DELIVERED + CONFIRMED)
      this.orderModel.aggregate([
        { $match: { status: { $in: SOLD_ORDER_STATUSES }, isDeleted: { $ne: true } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),

      // Monthly orders for current year (all statuses)
      this.orderModel.aggregate([
        { $match: { createdAt: { $gte: startOfYear }, isDeleted: { $ne: true } } },
        { $group: { _id: { $month: '$createdAt' }, count: { $sum: 1 } } },
        { $sort: { '_id': 1 } },
      ]),

      // Monthly revenue for current year (completed orders)
      this.orderModel.aggregate([
        { $match: { createdAt: { $gte: startOfYear }, status: { $in: SOLD_ORDER_STATUSES }, isDeleted: { $ne: true } } },
        { $group: { _id: { $month: '$createdAt' }, revenue: { $sum: '$total' } } },
        { $sort: { '_id': 1 } },
      ]),

      // Monthly new users for current year
      this.userModel.aggregate([
        { $match: { createdAt: { $gte: startOfYear } } },
        { $group: { _id: { $month: '$createdAt' }, count: { $sum: 1 } } },
        { $sort: { '_id': 1 } },
      ]),

      // Current month orders
      this.orderModel.countDocuments({
        createdAt: { $gte: startOfMonth, $lt: startOfNextMonth },
        isDeleted: { $ne: true },
      }).exec(),

      // Current month revenue
      this.orderModel.aggregate([
        { $match: { createdAt: { $gte: startOfMonth, $lt: startOfNextMonth }, status: { $in: SOLD_ORDER_STATUSES }, isDeleted: { $ne: true } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),

      // Current month new users
      this.userModel.countDocuments({
        createdAt: { $gte: startOfMonth, $lt: startOfNextMonth },
      }).exec(),

      // Orders by status
      this.orderModel.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    // Build 12-month arrays
    const monthlyOrders = Array.from({ length: 12 }, (_, i) => {
      const found = monthlyOrdersRaw.find((r: any) => r._id === i + 1);
      return { month: MONTH_LABELS[i], orders: found?.count || 0 };
    });

    const monthlyRevenue = Array.from({ length: 12 }, (_, i) => {
      const found = monthlyRevenueRaw.find((r: any) => r._id === i + 1);
      return { month: MONTH_LABELS[i], revenue: found?.revenue || 0 };
    });

    const monthlyUsers = Array.from({ length: 12 }, (_, i) => {
      const found = monthlyUsersRaw.find((r: any) => r._id === i + 1);
      return { month: MONTH_LABELS[i], users: found?.count || 0 };
    });

    const statusBreakdown = ordersByStatus.map((s: any) => ({ status: s._id, count: s.count }));

    return {
      totalOrders,
      totalProducts,
      totalUsers,
      totalRevenue: revenueAggregate[0]?.total || 0,
      currentMonth: {
        month: currentMonth + 1,
        year: currentYear,
        orders: currentMonthOrders,
        revenue: currentMonthRevenue[0]?.total || 0,
        newUsers: currentMonthUsers,
      },
      monthlyOrders,
      monthlyRevenue,
      monthlyUsers,
      statusBreakdown,
      recentOrders,
      topProducts: topProductsRaw,
    };
  }

  @Get('funnel')
  async getFunnel() {
    const [productViews, unitsSold, ordersCreated] = await Promise.all([
      this.productModel.aggregate([
        { $group: { _id: null, total: { $sum: '$viewCount' } } },
      ]),
      // Units sold across confirmed/completed orders (Product.orderCount is a
      // stale field that is never incremented by the real order flow).
      this.orderModel.aggregate([
        { $match: { status: { $in: SOLD_ORDER_STATUSES }, isDeleted: { $ne: true } } },
        { $unwind: '$items' },
        { $group: { _id: null, total: { $sum: '$items.quantity' } } },
      ]),
      this.orderModel.countDocuments(),
    ]);

    return {
      productViews: productViews[0]?.total || 0,
      unitsSold: unitsSold[0]?.total || 0,
      ordersCreated,
    };
  }

  @Get('revenue')
  async getRevenue(@Query('year') yearParam?: string) {
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year + 1, 0, 1);

    const COMPLETED = ['DELIVERED', 'CONFIRMED', 'SHIPPED', 'PROCESSING'];

    // Shared stages: unwind items, lookup product for costPrice
    const lookupCost = [
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',
          foreignField: '_id',
          as: '_p',
        },
      },
      { $addFields: { _p: { $arrayElemAt: ['$_p', 0] } } },
      {
        $addFields: {
          _cost: {
            $multiply: ['$items.quantity', { $ifNull: ['$_p.costPrice', 0] }],
          },
          _revenue: '$items.subtotal',
          _qty: '$items.quantity',
        },
      },
      {
        $addFields: {
          _profit: { $subtract: ['$_revenue', '$_cost'] },
        },
      },
    ];

    // An order counts as a marketplace channel (e.g. SHOPEE) when it was synced in via
    // that channel's importer (Order.externalRef.channel); a plain website order has
    // no externalRef at all.
    const channelOf = { $ifNull: ['$externalRef.channel', 'WEBSITE'] };

    const [
      monthlyRaw,
      byProductRaw,
      byCategoryRaw,
      summaryAllTime,
      summaryYear,
      externalBySourceRaw,
      externalMonthlyBySourceRaw,
      orderByChannelYearRaw,
      orderByChannelMonthlyRaw,
    ] =
      await Promise.all([
        // Monthly breakdown for the selected year
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: { $month: '$createdAt' },
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        // By product — filtered to selected year
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: '$items.productId',
              name: { $first: '$items.productName' },
              slug: { $first: '$_p.slug' },
              image: { $first: { $arrayElemAt: ['$_p.images', 0] } },
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 30 },
        ]),

        // By category — filtered to selected year
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: '$_p.category',
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
          {
            $lookup: {
              from: 'categories',
              localField: '_id',
              foreignField: '_id',
              as: '_cat',
            },
          },
          { $addFields: { _cat: { $arrayElemAt: ['$_cat', 0] } } },
          {
            $project: {
              categoryId: '$_id',
              categoryName: { $ifNull: ['$_cat.name', 'Không rõ'] },
              categorySlug: '$_cat.slug',
              revenue: 1,
              cost: 1,
              profit: 1,
              quantitySold: 1,
            },
          },
          { $sort: { revenue: -1 } },
        ]),

        // All-time summary
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: null,
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
        ]),

        // Year summary
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: null,
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
        ]),

        // External revenue — totals per source for the selected year
        this.externalRevenueModel.aggregate([
          { $match: { year } },
          {
            $group: {
              _id: '$source',
              revenue: { $sum: '$revenue' },
              cost: { $sum: { $add: ['$cost', '$platformFee'] } },
            },
          },
        ]),

        // External revenue — per source, per month, for the selected year
        this.externalRevenueModel.aggregate([
          { $match: { year } },
          {
            $group: {
              _id: { source: '$source', month: '$month' },
              revenue: { $sum: '$revenue' },
            },
          },
        ]),

        // Orders grouped by channel (WEBSITE vs. a marketplace channel like SHOPEE
        // the order was synced in from) — totals for the selected year
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: channelOf,
              revenue: { $sum: '$_revenue' },
              cost: { $sum: '$_cost' },
              profit: { $sum: '$_profit' },
              quantitySold: { $sum: '$_qty' },
            },
          },
        ]),

        // Orders grouped by channel, per month, for the selected year
        this.orderModel.aggregate([
          {
            $match: {
              status: { $in: COMPLETED },
              isDeleted: { $ne: true },
              createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
          },
          ...lookupCost,
          {
            $group: {
              _id: { channel: channelOf, month: { $month: '$createdAt' } },
              revenue: { $sum: '$_revenue' },
            },
          },
        ]),
      ]);

    const monthly = Array.from({ length: 12 }, (_, i) => {
      const m = monthlyRaw.find((r: any) => r._id === i + 1);
      return {
        month: MONTH_LABELS[i],
        revenue: m?.revenue || 0,
        cost: m?.cost || 0,
        profit: m?.profit || 0,
        quantitySold: m?.quantitySold || 0,
      };
    });

    const toSummary = (raw: any) => {
      const r = raw || { revenue: 0, cost: 0, profit: 0, quantitySold: 0 };
      return {
        revenue: r.revenue,
        cost: r.cost,
        profit: r.profit,
        profitMargin: r.revenue > 0 ? Math.round((r.profit / r.revenue) * 10000) / 100 : 0,
        quantitySold: r.quantitySold,
      };
    };

    const yearSummary = toSummary(summaryYear[0]);

    // Revenue by source: an order synced in from a marketplace (e.g. Shopee) rolls
    // up into that marketplace's source instead of WEBSITE (see `channelOf` above),
    // combined with any manually-entered ExternalRevenue rows for the same source.
    const orderByChannelYearMap = new Map(
      orderByChannelYearRaw.map((r: any) => [r._id, r]),
    );
    const externalBySourceMap = new Map(
      externalBySourceRaw.map((r: any) => [r._id, r]),
    );
    const bySource = ALL_SOURCES.map((source) => {
      const fromOrders = orderByChannelYearMap.get(source) as any;
      const fromExternal = source === 'WEBSITE' ? undefined : (externalBySourceMap.get(source) as any);
      const revenue = (fromOrders?.revenue || 0) + (fromExternal?.revenue || 0);
      const cost = (fromOrders?.cost || 0) + (fromExternal?.cost || 0);
      const profit = revenue - cost;
      return {
        source,
        revenue,
        cost,
        profit,
        profitMargin: revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0,
        quantitySold: fromOrders?.quantitySold || 0,
      };
    });

    const monthlyBySource = Array.from({ length: 12 }, (_, i) => {
      const entry: Record<string, number | string> = { month: MONTH_LABELS[i] };
      for (const source of ALL_SOURCES) {
        const fromOrders = orderByChannelMonthlyRaw.find(
          (r: any) => r._id.month === i + 1 && r._id.channel === source,
        );
        const fromExternal =
          source === 'WEBSITE'
            ? undefined
            : externalMonthlyBySourceRaw.find(
                (r: any) => r._id.month === i + 1 && r._id.source === source,
              );
        entry[source] = (fromOrders?.revenue || 0) + ((fromExternal as any)?.revenue || 0);
      }
      return entry;
    });

    return {
      year,
      allTime: toSummary(summaryAllTime[0]),
      yearSummary,
      monthly,
      bySource,
      monthlyBySource,
      byProduct: byProductRaw.map((p: any) => ({
        productId: String(p._id),
        name: p.name,
        slug: p.slug,
        image: p.image,
        revenue: p.revenue,
        cost: p.cost,
        profit: p.profit,
        profitMargin: p.revenue > 0 ? Math.round((p.profit / p.revenue) * 10000) / 100 : 0,
        quantitySold: p.quantitySold,
      })),
      byCategory: byCategoryRaw.map((c: any) => ({
        categoryId: c.categoryId ? String(c.categoryId) : null,
        name: c.categoryName,
        slug: c.categorySlug,
        revenue: c.revenue,
        cost: c.cost,
        profit: c.profit,
        profitMargin: c.revenue > 0 ? Math.round((c.profit / c.revenue) * 10000) / 100 : 0,
        quantitySold: c.quantitySold,
      })),
    };
  }
}
