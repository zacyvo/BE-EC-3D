import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZaloOaRewardService } from './zalo-oa-reward.service';
import { ZaloOaWebhookService } from './zalo-oa-webhook.service';
import { ZALO_OA_SIGNATURE_HEADER } from './zalo-oa-reward.constants';

export class RewardPhoneDto {
  /** Optional, unverified. Empty string clears it. */
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class MiniAppIdentityDto {
  @IsString() @MaxLength(64) rs: string;
  @IsString() @MaxLength(4096) accessToken: string;
}

/** Order-owner endpoints. Every call is scoped to (JWT user, orderId): another customer's
 * order returns 404, so nobody can read someone else's reward or coupon. */
@Controller('zalo-oa-reward/orders')
@UseGuards(JwtAuthGuard)
export class ZaloOaRewardController {
  constructor(private readonly rewards: ZaloOaRewardService) {}

  @Post(':orderId/session')
  open(@CurrentUser() user: { sub: string }, @Param('orderId') orderId: string) {
    return this.rewards.openForOrder(user.sub, orderId);
  }

  @Get(':orderId/status')
  status(@CurrentUser() user: { sub: string }, @Param('orderId') orderId: string) {
    return this.rewards.getStatus(user.sub, orderId);
  }

  @Post(':orderId/link')
  link(@CurrentUser() user: { sub: string }, @Param('orderId') orderId: string) {
    return this.rewards.prepareLink(user.sub, orderId);
  }

  @Put(':orderId/reward-phone')
  phone(@CurrentUser() user: { sub: string }, @Param('orderId') orderId: string, @Body() dto: RewardPhoneDto) {
    return this.rewards.setRewardPhone(user.sub, orderId, dto.phone);
  }

  @Post(':orderId/dismiss')
  dismiss(@CurrentUser() user: { sub: string }, @Param('orderId') orderId: string) {
    return this.rewards.dismiss(user.sub, orderId);
  }
}

/** Public endpoints reached from Zalo (QR / deep link / OAuth redirect / Mini App). They only
 * accept opaque references and provider-verified credentials — never a raw UID. */
@Controller('zalo-oa-reward')
@UseGuards(ThrottlerGuard)
export class ZaloOaRewardPublicController {
  constructor(private readonly rewards: ZaloOaRewardService) {}

  @Get('connect')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async connect(@Query('rs') rs: unknown, @Res() res: Response) {
    const { url } = await this.rewards.beginConnect(rs);
    redirect(res, url);
  }

  @Get('oauth/callback')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async callback(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { url } = await this.rewards.handleOAuthCallback({ code: query.code, state: query.state, error: query.error });
    redirect(res, url);
  }

  @Post('mini-app/identity')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  miniAppIdentity(@Body() dto: MiniAppIdentityDto) {
    return this.rewards.bindMiniAppIdentity(dto.rs, dto.accessToken);
  }
}

/** POST /api/v1/webhooks/zalo-oa — the OA webhook (NOT the Zalo Bot webhook). Needs the raw
 * body for X-ZEvent-Signature; main.ts captures it for this path only. */
@Controller('webhooks/zalo-oa')
export class ZaloOaWebhookController {
  constructor(private readonly webhook: ZaloOaWebhookService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  receive(@Req() req: Request & { rawBody?: Buffer }, @Headers(ZALO_OA_SIGNATURE_HEADER) signature: string | undefined) {
    return this.webhook.handle(req.rawBody, signature);
  }
}

function redirect(res: Response, url: string): void {
  // The URL may carry an opaque ref/state: never cache it, never leak it via Referer.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, url);
}
