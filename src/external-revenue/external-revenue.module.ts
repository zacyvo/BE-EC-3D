import { Module, Controller, Get, Post, Patch, Delete, Body, Param, Query, NotFoundException } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  IsEnum, IsInt, IsNumber, IsOptional, IsString,
  MaxLength, Min, Max,
} from 'class-validator';
import {
  ExternalRevenue,
  ExternalRevenueDocument,
  ExternalRevenueSchema,
  ExternalSource,
} from './schemas/external-revenue.schema';
import { JwtStaffGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, StaffRole } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

// ── DTOs ──────────────────────────────────────────────────────────────────────

class CreateExternalRevenueDto {
  @IsEnum(ExternalSource)
  source: ExternalSource;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2000)
  year: number;

  @IsNumber()
  @Min(0)
  revenue: number;

  @IsNumber()
  @Min(0)
  cost: number;

  @IsNumber()
  @Min(0)
  platformFee: number;
}

class UpdateExternalRevenueDto {
  @IsOptional()
  @IsEnum(ExternalSource)
  source?: ExternalSource;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsInt()
  @Min(2000)
  year?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  revenue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  platformFee?: number;
}

// ── Controller ────────────────────────────────────────────────────────────────

@Controller('admin/external-revenue')
@UseGuards(JwtStaffGuard, RolesGuard)
@Roles(StaffRole.SUPER_ADMIN, StaffRole.ADMIN)
export class ExternalRevenueController {
  constructor(
    @InjectModel(ExternalRevenue.name)
    private readonly model: Model<ExternalRevenueDocument>,
  ) {}

  @Get()
  async findAll(@Query('year') yearParam?: string) {
    const filter: Record<string, unknown> = {};
    if (yearParam) filter.year = parseInt(yearParam, 10);
    return this.model.find(filter).sort({ year: -1, month: 1 }).lean().exec();
  }

  @Post()
  async create(
    @Body() dto: CreateExternalRevenueDto,
    @CurrentUser() staff: { sub: string },
  ) {
    return this.model.create({ ...dto, note: dto.note ?? '', createdBy: staff.sub });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateExternalRevenueDto) {
    const doc = await this.model
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Record not found');
    return doc;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const doc = await this.model.findByIdAndDelete(id).exec();
    if (!doc) throw new NotFoundException('Record not found');
    return { message: 'Deleted' };
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExternalRevenue.name, schema: ExternalRevenueSchema },
    ]),
  ],
  controllers: [ExternalRevenueController],
  exports: [MongooseModule],
})
export class ExternalRevenueModule {}
