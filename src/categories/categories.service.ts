import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import slugify from 'slugify';
import { Category, CategoryDocument } from './schemas/category.schema';
import { IsString, IsOptional, IsBoolean, MinLength, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export interface AdminListQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: string;
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
  ) {}

  async create(dto: CreateCategoryDto, staffId: string): Promise<CategoryDocument> {
    const slug = slugify(dto.name, { lower: true, strict: true });
    const existing = await this.categoryModel.findOne({ slug }).exec();
    if (existing) throw new ConflictException('Category already exists');

    return this.categoryModel.create({ ...dto, slug, createdBy: staffId });
  }

  async findAll(activeOnly = true) {
    const filter = activeOnly ? { isActive: true } : {};
    return this.categoryModel.find(filter).sort({ name: 1 }).lean().exec();
  }

  async findAllPaginated(query: AdminListQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (query.search) {
      filter.name = { $regex: query.search, $options: 'i' };
    }
    if (query.isActive === 'true') filter.isActive = true;
    else if (query.isActive === 'false') filter.isActive = false;

    const [items, total] = await Promise.all([
      this.categoryModel.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean().exec(),
      this.categoryModel.countDocuments(filter),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: string): Promise<CategoryDocument> {
    const cat = await this.categoryModel.findById(id).exec();
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  async update(id: string, data: Partial<CreateCategoryDto>): Promise<CategoryDocument> {
    const updateData: Record<string, unknown> = { ...data };
    if (data.name) {
      updateData.slug = slugify(data.name, { lower: true, strict: true });
    }
    const cat = await this.categoryModel
      .findByIdAndUpdate(id, { $set: updateData }, { new: true })
      .exec();
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  async toggleActive(id: string): Promise<CategoryDocument> {
    const cat = await this.categoryModel.findById(id).exec();
    if (!cat) throw new NotFoundException('Category not found');
    cat.isActive = !cat.isActive;
    await cat.save();
    return cat;
  }

  async softDelete(id: string, staffId: string): Promise<void> {
    const cat = await this.categoryModel.findById(id).exec();
    if (!cat) throw new NotFoundException('Category not found');
    cat.isDeleted = true;
    cat.deletedAt = new Date();
    cat.deletedBy = staffId;
    await cat.save();
  }
}
