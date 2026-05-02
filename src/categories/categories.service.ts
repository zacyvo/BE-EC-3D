import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import slugify from 'slugify';
import { Category, CategoryDocument } from './schemas/category.schema';
import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsOptional() @IsString() description?: string;
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

  async findById(id: string): Promise<CategoryDocument> {
    const cat = await this.categoryModel.findById(id).exec();
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  async update(id: string, data: Partial<CreateCategoryDto>): Promise<CategoryDocument> {
    const cat = await this.categoryModel
      .findByIdAndUpdate(id, { $set: data }, { new: true })
      .exec();
    if (!cat) throw new NotFoundException('Category not found');
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
