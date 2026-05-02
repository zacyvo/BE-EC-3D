import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-ec-3d';

async function seed() {
  console.log('🌱 Starting seed...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const db = mongoose.connection;

  // Clear existing data
  await Promise.all([
    db.collection('staff').deleteMany({}),
    db.collection('categories').deleteMany({}),
    db.collection('products').deleteMany({}),
  ]);

  // ── Staff ─────────────────────────────────────────────────────────────────
  const superAdminPassword = await bcrypt.hash('SuperAdmin@123', 12);
  const adminPassword = await bcrypt.hash('Admin@123456', 12);
  const csPassword = await bcrypt.hash('CS@1234567', 12);

  await db.collection('staff').insertMany([
    {
      email: 'superadmin@web-ec-3d.com',
      password: superAdminPassword,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      email: 'admin@web-ec-3d.com',
      password: adminPassword,
      name: 'Admin User',
      role: 'ADMIN',
      isActive: true,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      email: 'cs@web-ec-3d.com',
      password: csPassword,
      name: 'CS Agent',
      role: 'CS',
      isActive: true,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  console.log('✅ Staff seeded');

  // ── Categories ────────────────────────────────────────────────────────────
  const catResult = await db.collection('categories').insertMany([
    { name: 'Đèn Bàn', slug: 'den-ban', isActive: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date() },
    { name: 'Đèn Trần', slug: 'den-tran', isActive: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date() },
    { name: 'Đèn Tường', slug: 'den-tuong', isActive: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date() },
    { name: 'Đèn Ngủ', slug: 'den-ngu', isActive: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date() },
    { name: 'Đèn Trang Trí', slug: 'den-trang-tri', isActive: true, isDeleted: false, createdAt: new Date(), updatedAt: new Date() },
  ]);
  console.log('✅ Categories seeded');

  const catIds = Object.values(catResult.insertedIds);

  // ── Products ──────────────────────────────────────────────────────────────
  const products = [
    {
      name: 'Đèn Bàn Lotus 3D',
      slug: 'den-ban-lotus-3d',
      images: [
        'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?w=800',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800',
        'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800',
      ],
      category: catIds[0],
      costPrice: 350000,
      sellingPrice: 650000,
      discountPercent: 0,
      finalPrice: 650000,
      profit: 300000,
      profitPercent: 85,
      stock: 50,
      eta: '3-5 ngày',
      shortDescription: 'Đèn bàn in 3D hình hoa sen, ánh sáng ấm áp',
      description: 'Đèn bàn Lotus 3D được in bằng công nghệ FDM với chất liệu PLA cao cấp. Thiết kế lấy cảm hứng từ hoa sen, mang lại không gian ấm cúng và tinh tế cho góc học tập hoặc làm việc của bạn.',
      isActive: true,
      isDeleted: false,
      viewCount: 245,
      orderCount: 38,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Đèn Trần Geometric',
      slug: 'den-tran-geometric',
      images: [
        'https://images.unsplash.com/photo-1524484485831-a92ffc0de03f?w=800',
        'https://images.unsplash.com/photo-1540932239986-30128078f3c5?w=800',
        'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800',
      ],
      category: catIds[1],
      costPrice: 500000,
      sellingPrice: 950000,
      discountPercent: 10,
      finalPrice: 855000,
      profit: 355000,
      profitPercent: 71,
      stock: 30,
      eta: '5-7 ngày',
      shortDescription: 'Đèn trần hình học 3D độc đáo, phong cách tối giản',
      description: 'Đèn trần Geometric với thiết kế hình học độc đáo, được in 3D tỉ mỉ từng chi tiết. Phù hợp với phòng khách, phòng ngủ hoặc không gian làm việc hiện đại.',
      isActive: true,
      isDeleted: false,
      viewCount: 189,
      orderCount: 22,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Đèn Ngủ Moon Phase',
      slug: 'den-ngu-moon-phase',
      images: [
        'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800',
        'https://images.unsplash.com/photo-1558618047-f8cbfde71bb0?w=800',
        'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=800',
      ],
      category: catIds[3],
      costPrice: 200000,
      sellingPrice: 420000,
      discountPercent: 0,
      finalPrice: 420000,
      profit: 220000,
      profitPercent: 110,
      stock: 100,
      eta: '2-3 ngày',
      shortDescription: 'Đèn ngủ hình mặt trăng in 3D, ánh sáng dịu nhẹ',
      description: 'Đèn ngủ Moon Phase với hình dạng trăng non tuyệt đẹp. In 3D từ chất liệu PLA mờ, ánh sáng khuếch tán nhẹ nhàng tạo cảm giác thư giãn trước khi ngủ.',
      isActive: true,
      isDeleted: false,
      viewCount: 412,
      orderCount: 67,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Đèn Tường Voronoi',
      slug: 'den-tuong-voronoi',
      images: [
        'https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=800',
        'https://images.unsplash.com/photo-1571508601891-ca5e7a713859?w=800',
        'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800',
      ],
      category: catIds[2],
      costPrice: 650000,
      sellingPrice: 1200000,
      discountPercent: 15,
      finalPrice: 1020000,
      profit: 370000,
      profitPercent: 56,
      stock: 20,
      eta: '7-10 ngày',
      shortDescription: 'Đèn tường họa tiết Voronoi 3D độc bản',
      description: 'Đèn tường Voronoi với cấu trúc tế bào tự nhiên tuyệt đẹp. Mỗi chiếc đèn là một tác phẩm nghệ thuật độc bản, được in 3D với độ chính xác cao bằng máy FDM công nghiệp.',
      isActive: true,
      isDeleted: false,
      viewCount: 156,
      orderCount: 15,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Đèn Trang Trí Cactus',
      slug: 'den-trang-tri-cactus',
      images: [
        'https://images.unsplash.com/photo-1574279606130-09958dc756f7?w=800',
        'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800',
        'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?w=800',
      ],
      category: catIds[4],
      costPrice: 180000,
      sellingPrice: 380000,
      discountPercent: 5,
      finalPrice: 361000,
      profit: 181000,
      profitPercent: 100,
      stock: 75,
      eta: '2-3 ngày',
      shortDescription: 'Đèn xương rồng mini 3D cute, trang trí bàn làm việc',
      description: 'Bộ đèn trang trí hình xương rồng mini cực cute! Được in 3D từ PLA màu xanh lá, có tích hợp LED RGB có thể đổi màu. Siêu cute cho bàn làm việc, kệ sách hay phòng của các bé.',
      isActive: true,
      isDeleted: false,
      viewCount: 523,
      orderCount: 89,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await db.collection('products').insertMany(products);
  console.log('✅ Products seeded');

  await mongoose.disconnect();
  console.log('🎉 Seed completed!');
  console.log('\n📋 Staff credentials:');
  console.log('  SUPER_ADMIN: superadmin@web-ec-3d.com / SuperAdmin@123');
  console.log('  ADMIN:       admin@web-ec-3d.com / Admin@123456');
  console.log('  CS:          cs@web-ec-3d.com / CS@1234567');
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
