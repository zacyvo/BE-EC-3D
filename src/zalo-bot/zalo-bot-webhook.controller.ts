import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'crypto';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZALO_WEBHOOK_SECRET_HEADER } from './zalo-bot.constants';
import { InboundChat, ZaloOwnerRecipientService, maskChatId } from './zalo-owner-recipient.service';

/** Constant-time comparison (hashing first makes lengths equal). */
export function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The documented envelope is `{ ok, result: { event_name, message } }`; also accept the event
 * at the top level (`{ event_name, message }`) in case real deliveries differ from the docs. */
function eventObject(body: unknown): Record<string, unknown> | undefined {
  const root = asRecord(body);
  const wrapped = asRecord(root?.result);
  if (wrapped && ('event_name' in wrapped || 'message' in wrapped)) return wrapped;
  if (root && ('event_name' in root || 'message' in root)) return root;
  return wrapped;
}

/** Field names only (never values) — lets ops see an unexpected payload shape in the logs
 * without logging message content or ids. */
export function describePayloadShape(body: unknown): string {
  const root = asRecord(body);
  if (!root) return `type=${Array.isArray(body) ? 'array' : typeof body}`;
  const evt = eventObject(body);
  const message = asRecord(evt?.message);
  return [
    `keys=[${Object.keys(root).join(',')}]`,
    evt && evt !== root ? `result=[${Object.keys(evt).join(',')}]` : '',
    message ? `message=[${Object.keys(message).join(',')}]` : '',
    message?.chat ? `chat=[${Object.keys(asRecord(message.chat) ?? {}).join(',')}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Extracts the chat from a `message.text.received` event
 * (docs.zaloplatforms.com/docs/BOT/webhook):
 *   { ok: true, result: { event_name, message: { from: {id, display_name, is_bot}, chat: {id, chat_type}, text, ... } } }
 * Returns null for anything else — other event types and malformed bodies are ignored.
 */
export function parseTextReceivedEvent(body: unknown): { eventName: string | null; chat: InboundChat | null } {
  const result = eventObject(body);
  const eventName = typeof result?.event_name === 'string' ? result.event_name : null;
  if (eventName !== 'message.text.received') return { eventName, chat: null };

  const message = result?.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const from = message?.from as Record<string, unknown> | undefined;
  const rawId = chat?.id;
  if ((typeof rawId !== 'string' && typeof rawId !== 'number') || String(rawId).trim() === '') {
    return { eventName, chat: null };
  }
  const chatId = String(rawId).trim();
  if (chatId.length > 128 || from?.is_bot === true) return { eventName, chat: null };

  return {
    eventName,
    chat: {
      chatId,
      chatType: typeof chat?.chat_type === 'string' ? chat.chat_type.slice(0, 20) : undefined,
      displayName: typeof from?.display_name === 'string' ? from.display_name : undefined,
    },
  };
}

/**
 * Public endpoint Zalo calls: POST /api/v1/webhooks/zalo-bot
 *
 * Purpose: chat id discovery for owner enrollment + webhook health (testWebhook/setWebhook
 * verification). It never authorizes anyone and never sends messages. Works regardless of
 * ZALO_BOT_ENABLED so the owner can enroll before notifications are switched on; requires
 * ZALO_BOT_WEBHOOK_SECRET to be configured.
 *
 * `@Body() body: unknown` keeps the global whitelist ValidationPipe from rejecting Zalo's
 * payload (it skips plain Object metatypes) — the shape is validated by hand instead.
 */
@Controller('webhooks/zalo-bot')
export class ZaloBotWebhookController {
  private readonly logger = new Logger(ZaloBotWebhookController.name);

  constructor(
    private readonly configService: ZaloBotConfigService,
    private readonly recipients: ZaloOwnerRecipientService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async receive(@Headers(ZALO_WEBHOOK_SECRET_HEADER) secret: string | undefined, @Body() body: unknown) {
    const expected = this.configService.get().webhookSecret;
    if (!expected) {
      this.logger.warn('Webhook Zalo Bot bị gọi nhưng ZALO_BOT_WEBHOOK_SECRET chưa cấu hình');
      throw new ServiceUnavailableException('Webhook not configured');
    }
    if (!secretMatches(secret, expected)) {
      this.logger.warn(`Webhook Zalo Bot: từ chối request sai secret (header ${secret ? 'có' : 'thiếu'})`);
      throw new ForbiddenException('Unauthorized');
    }

    const { eventName, chat } = parseTextReceivedEvent(body);
    if (!chat) {
      // testWebhook probes, other event types (image/sticker/voice/unsupported), malformed
      // bodies: acknowledge so Zalo marks the endpoint healthy, but do nothing.
      this.logger.log(`Webhook Zalo Bot: bỏ qua sự kiện ${eventName ?? '(không có event_name)'} — ${describePayloadShape(body)}`);
      return { received: true, handled: false, event: eventName };
    }

    const outcome = await this.recipients.recordInboundChat(chat);
    this.logger.log(`Webhook Zalo Bot: ${eventName} từ chat ${maskChatId(chat.chatId)} → ${outcome}`);
    return { received: true, handled: true };
  }
}
