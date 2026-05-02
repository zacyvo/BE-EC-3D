import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { Order } from '../orders/schemas/order.schema';
import { Product } from '../products/schemas/product.schema';
import { User } from '../users/schemas/user.schema';

@Controller('admin/analytics')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class AnalyticsController {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<any>,
    @InjectModel(Product.name) private productModel: Model<any>,
    @InjectModel(User.name) private userModel: Model<any>,
  ) {}

  @Get('dashboard')
  async getDashboard() {
    const [totalOrders, totalProducts, totalUsers, recentOrders, topProducts] =
      await Promise.all([
        this.orderModel.countDocuments().exec(),
        this.productModel.countDocuments().exec(),
        this.userModel.countDocuments().exec(),
        this.orderModel
          .find()
          .populate('userId', 'name email')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean()
          .exec(),
        this.productModel
          .find()
          .sort({ orderCount: -1, viewCount: -1 })
          .limit(5)
          .select('name slug images finalPrice orderCount viewCount')
          .lean()
          .exec(),
      ]);

    const revenue = await this.orderModel.aggregate([
      { $match: { status: { $in: ['DELIVERED', 'CONFIRMED'] }, isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);

    return {
      stats: {
        totalOrders,
        totalProducts,
        totalUsers,
        totalRevenue: revenue[0]?.total || 0,
      },
      recentOrders,
      topProducts,
    };
  }

  @Get('funnel')
  async getFunnel() {
    const [productViews, addedToCart, ordersCreated] = await Promise.all([
      this.productModel.aggregate([
        { $group: { _id: null, total: { $sum: '$viewCount' } } },
      ]),
      this.productModel.aggregate([
        { $group: { _id: null, total: { $sum: '$orderCount' } } },
      ]),
      this.orderModel.countDocuments(),
    ]);

    return {
      productViews: productViews[0]?.total || 0,
      addToCart: addedToCart[0]?.total || 0,
      ordersCreated,
    };
  }
}
