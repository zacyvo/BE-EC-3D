import { Controller, Get, Post, Patch, Body, UseGuards } from '@nestjs/common';
import { CartService, AddToCartDto, UpdateCartItemDto } from './cart.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@CurrentUser() user: { sub: string }) {
    return this.cartService.getCart(user.sub);
  }

  @Post('items')
  addItem(@CurrentUser() user: { sub: string }, @Body() dto: AddToCartDto) {
    return this.cartService.addItem(user.sub, dto);
  }

  @Patch('items')
  updateItem(@CurrentUser() user: { sub: string }, @Body() dto: UpdateCartItemDto) {
    return this.cartService.updateItem(user.sub, dto);
  }
}
