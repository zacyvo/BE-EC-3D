import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Promotion, PromotionSchema } from './schemas/promotion.schema';
import { PromotionsService } from './promotions.service';
import { PromotionsController, AdminPromotionsController } from './promotions.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Promotion.name, schema: PromotionSchema }]),
  ],
  controllers: [PromotionsController, AdminPromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
