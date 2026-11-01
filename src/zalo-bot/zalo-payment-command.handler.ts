import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PaymentConfirmationSource } from '../orders/schemas/order.schema';
import {
  ConfirmActor,
  ConfirmOutcome,
  describeConfirmOutcome,
  orderCodeOf,
  PaymentConfirmationService,
  PendingBankTransfer,
} from '../payments/payment-confirmation.service';
import { PaymentEventAction, PaymentEventResult } from '../payments/schemas/payment-event.schema';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotClient } from './zalo-bot.client';
import { formatVnd, ORDER_STATUS_LABELS } from './order-message.formatter';
import { maskChatId } from './zalo-owner-recipient.service';
import { InfoCommand, PAYMENT_COMMAND_HELP, parseInfoCommand, parsePaymentCommand } from './payment-command.parser';
import { ZALO_MESSAGE_MAX_LENGTH } from './zalo-bot.constants';

/** A text message from the webhook, already shape-checked by the controller. */
export interface InboundTextMessage {
  /** message.from.id — the sender. The ONLY thing authorization looks at. */
  fromId: string;
  /** message.chat.id — where the reply goes. */
  chatId: string;
  chatType?: string;
  messageId?: string;
  /** message.date, Unix ms. */
  date?: number;
  text: string;
}

export type PaymentCommandOutcome =
  | 'not_command'
  | 'unauthorized'
  | 'duplicate'
  | 'not_private'
  | 'expired'
  | 'invalid'
  | 'listed'
  | 'help'
  | PaymentEventResult;

/** At most this many orders in one "Danh sách" answer (Zalo text limit 2000 chars). */
export const PENDING_LIST_LIMIT = 15;

/** A command older than this is refused (re-sent / replayed stale message). */
export const PAYMENT_COMMAND_MAX_AGE_MS = 30 * 60 * 1000;

const GENERIC_ERROR = 'Hệ thống đang gặp sự cố, chưa xác nhận được thanh toán. Vui lòng thử lại sau ít phút.';

export function formatPaymentConfirmedReply(outcome: Extract<ConfirmOutcome, { result: PaymentEventResult.SUCCESS }>, confirmedBy: string): string {
  const order = outcome.order;
  return [
    '✅ XÁC NHẬN THANH TOÁN THÀNH CÔNG',
    '',
    `🛍 Đơn hàng: ${orderCodeOf(order)}`,
    `💰 Số tiền: ${formatVnd(order.payment?.amount ?? order.total)}`,
    '💳 Phương thức: Chuyển khoản ngân hàng',
    '✅ Trạng thái: Đã thanh toán',
    `📦 Đơn hàng: ${ORDER_STATUS_LABELS[order.status] ?? order.status}`,
    `👤 Xác nhận bởi: ${confirmedBy}`,
  ].join('\n');
}

export const ADMIN_COMMANDS_HELP = [
  '🤖 LỆNH QUẢN TRỊ LUXE GLOW',
  '',
  '📋 Danh sách',
  '→ Các đơn chuyển khoản đang chờ xác nhận thanh toán',
  '',
  '✅ Đơn hàng: LGxxxxxxxx',
  'Đã thanh toán',
  '→ Xác nhận đã nhận tiền (đơn chuyển sang Đang chuẩn bị hàng)',
  '',
  '❓ Hướng dẫn',
  '→ Xem lại danh sách lệnh',
].join('\n');

function shortDateTime(d: Date | string | undefined): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(d));
}

/** "Danh sách" answer: customer-reported transfers first, each with the reference to confirm. */
export function formatPendingList(items: PendingBankTransfer[], total: number, adminUrl?: string): string {
  if (!items.length) return '✅ Không có đơn chuyển khoản nào đang chờ xác nhận thanh toán.';
  const reported = items.filter((i) => i.reportedAt);
  const others = items.filter((i) => !i.reportedAt);
  const line = (i: PendingBankTransfer, n: number) =>
    `${n}) ${i.reference} · ${formatVnd(i.amount)}${i.customerName ? ` · ${i.customerName.slice(0, 40)}` : ''}` +
    ` · ${i.reportedAt ? `báo CK ${shortDateTime(i.reportedAt)}` : `đặt ${shortDateTime(i.createdAt)}`}`;

  const lines = [`📋 ĐƠN CHỜ XÁC NHẬN THANH TOÁN (${total})`];
  let n = 0;
  if (reported.length) {
    lines.push('', `🔔 Khách đã báo chuyển khoản (${reported.length}):`);
    reported.forEach((i) => lines.push(line(i, ++n)));
  }
  if (others.length) {
    lines.push('', `⏳ Khách chưa báo chuyển khoản (${others.length}):`);
    others.forEach((i) => lines.push(line(i, ++n)));
  }
  if (total > items.length) {
    lines.push('', `… và ${total - items.length} đơn khác${adminUrl ? ` — xem tại ${adminUrl.replace(/\/+$/, '')}/orders` : ''}`);
  }
  lines.push('', 'Kiểm tra tài khoản rồi gửi:', 'Đơn hàng: LGxxxxxxxx', 'Đã thanh toán');
  const message = lines.join('\n');
  return message.length > ZALO_MESSAGE_MAX_LENGTH ? `${message.slice(0, ZALO_MESSAGE_MAX_LENGTH - 1)}…` : message;
}

/**
 * "Đơn hàng: LG… / Đã thanh toán" from an authorized admin → PaymentConfirmationService.confirm()
 * (the same service as the Admin CMS button) → reply in the admin's chat.
 *
 * Trust model (docs/VIETQR_PAYMENT.md §Security): Zalo signs nothing — the webhook is
 * authenticated only by the shared secret header (checked by the controller). On top of that:
 *  - the sender must be in ZALO_PAYMENT_ADMIN_IDS, matched on message.from.id — never on display
 *    name, phone number or message content — and this is checked before any order is looked up;
 *  - only private chats (a group reply would expose order data to other members);
 *  - every message is claimed once by message_id (re-delivery / replay → ignored, no 2nd reply);
 *  - stale commands (> 30 min old) are refused;
 *  - the PAID transition itself is an atomic conditional update (no double confirmation).
 */
@Injectable()
export class ZaloPaymentCommandHandler {
  private readonly logger = new Logger(ZaloPaymentCommandHandler.name);

  constructor(
    private readonly configService: ZaloBotConfigService,
    private readonly client: ZaloBotClient,
    private readonly payments: PaymentConfirmationService,
  ) {}

  async handle(msg: InboundTextMessage, now: Date = new Date()): Promise<PaymentCommandOutcome> {
    const command = parsePaymentCommand(msg.text);
    if (command.kind === 'NOT_COMMAND') {
      const info = parseInfoCommand(msg.text);
      return info ? this.handleInfo(info, msg) : 'not_command';
    }

    // 1. Authorization first — nothing about any order is read for an unknown sender.
    const admin = this.configService.get().paymentAdmins.find((a) => a.zaloId === msg.fromId);
    if (!admin) {
      this.logger.warn(`Lệnh thanh toán từ người gửi không có quyền ${maskChatId(msg.fromId)} — từ chối`);
      // Reply only to a well-formed command: random chat starting with "đơn hàng" stays silent.
      if (command.kind === 'CONFIRM_PAYMENT') await this.reply(msg, 'Bạn không có quyền xác nhận thanh toán.');
      return 'unauthorized';
    }

    const actor: ConfirmActor = {
      source: PaymentConfirmationSource.ZALO_ADMIN_BOT,
      actorId: `zalo:${msg.fromId}`,
      actorName: admin.label || 'Admin',
      senderZaloId: msg.fromId,
      ...(msg.messageId ? { providerMessageId: msg.messageId } : {}),
    };

    // 2. Idempotency — claim the message before doing anything visible.
    const event = await this.claim(msg, actor);
    if (event === 'error') {
      await this.reply(msg, GENERIC_ERROR);
      return PaymentEventResult.ERROR;
    }
    if (!event) {
      this.logger.log(`Lệnh thanh toán ${msg.messageId ?? '(không có message_id)'} đã xử lý trước đó — bỏ qua`);
      return 'duplicate';
    }

    let result: PaymentCommandOutcome;
    let replyText: string;
    try {
      if (msg.chatType && msg.chatType.toUpperCase() !== 'PRIVATE') {
        result = 'not_private';
        replyText = 'Vui lòng gửi lệnh xác nhận thanh toán trong cuộc trò chuyện riêng với bot.';
        await this.payments.finishBotEvent(event._id, { result: PaymentEventResult.NOT_PRIVATE_CHAT, errorReason: replyText });
      } else if (msg.date && now.getTime() - msg.date > PAYMENT_COMMAND_MAX_AGE_MS) {
        result = 'expired';
        replyText = 'Lệnh này đã quá 30 phút nên không được xử lý. Vui lòng kiểm tra lại và gửi lệnh mới.';
        await this.payments.finishBotEvent(event._id, { result: PaymentEventResult.EXPIRED_COMMAND, errorReason: replyText });
      } else if (command.kind === 'INVALID') {
        result = 'invalid';
        replyText =
          command.reason === 'MULTIPLE_ORDERS'
            ? 'Mỗi lệnh chỉ được xác nhận 1 đơn hàng. Vui lòng gửi riêng từng đơn:\nĐơn hàng: LGxxxxxxxx\nĐã thanh toán'
            : PAYMENT_COMMAND_HELP;
        await this.payments.finishBotEvent(event._id, { result: PaymentEventResult.INVALID_COMMAND, errorReason: command.reason });
      } else {
        const resolved = await this.payments.resolveOrder(command.orderRef);
        let outcome: ConfirmOutcome;
        if ('order' in resolved) {
          outcome = await this.payments.confirm(resolved.order, actor, { eventId: event._id });
        } else {
          outcome = resolved;
          await this.payments.recordUnresolved(resolved, actor, event._id);
        }
        result = outcome.result;
        replyText =
          outcome.result === PaymentEventResult.SUCCESS
            ? formatPaymentConfirmedReply(outcome, actor.actorName!)
            : describeConfirmOutcome(outcome);
      }
    } catch (err) {
      // DB failure etc.: nothing was confirmed (or the atomic update is the last thing that ran).
      this.logger.error(`Lỗi xử lý lệnh thanh toán: ${(err as Error).message}`);
      await this.payments
        .finishBotEvent(event._id, { result: PaymentEventResult.ERROR, errorReason: 'INTERNAL_ERROR' })
        .catch(() => undefined);
      await this.reply(msg, GENERIC_ERROR);
      return PaymentEventResult.ERROR;
    }

    const replyStatus = await this.reply(msg, replyText);
    await this.payments.finishBotEvent(event._id, { replyStatus }).catch(() => undefined);
    return result;
  }

  /** "Danh sách" / "Hướng dẫn": admins only (strangers get silence — nothing reveals the
   * commands exist), private chat only. The list exposes customer names, so it is deduped and
   * recorded like a confirmation. */
  private async handleInfo(info: InfoCommand, msg: InboundTextMessage): Promise<PaymentCommandOutcome> {
    const cfg = this.configService.get();
    const admin = cfg.paymentAdmins.find((a) => a.zaloId === msg.fromId);
    if (!admin) {
      this.logger.warn(`Lệnh ${info} từ người gửi không có quyền ${maskChatId(msg.fromId)} — bỏ qua`);
      return 'unauthorized';
    }
    if (msg.chatType && msg.chatType.toUpperCase() !== 'PRIVATE') {
      await this.reply(msg, 'Vui lòng gửi lệnh quản trị trong cuộc trò chuyện riêng với bot.');
      return 'not_private';
    }
    if (info === 'HELP') {
      await this.reply(msg, ADMIN_COMMANDS_HELP);
      return 'help';
    }

    const actor: ConfirmActor = {
      source: PaymentConfirmationSource.ZALO_ADMIN_BOT,
      actorId: `zalo:${msg.fromId}`,
      actorName: admin.label || 'Admin',
      senderZaloId: msg.fromId,
      ...(msg.messageId ? { providerMessageId: msg.messageId } : {}),
    };
    const event = await this.claim(msg, actor, PaymentEventAction.LIST_PENDING);
    if (!event) return 'duplicate';
    if (event === 'error') {
      await this.reply(msg, 'Hệ thống đang gặp sự cố, chưa lấy được danh sách. Vui lòng thử lại sau ít phút.');
      return PaymentEventResult.ERROR;
    }
    try {
      const { items, total } = await this.payments.listPendingBankTransfers(PENDING_LIST_LIMIT);
      const replyStatus = await this.reply(msg, formatPendingList(items, total, cfg.adminUrl));
      await this.payments
        .finishBotEvent(event._id, { result: PaymentEventResult.LISTED, amount: total, replyStatus })
        .catch(() => undefined);
      return 'listed';
    } catch (err) {
      this.logger.error(`Lỗi lấy danh sách đơn chờ thanh toán: ${(err as Error).message}`);
      await this.payments
        .finishBotEvent(event._id, { result: PaymentEventResult.ERROR, errorReason: 'INTERNAL_ERROR' })
        .catch(() => undefined);
      await this.reply(msg, 'Hệ thống đang gặp sự cố, chưa lấy được danh sách. Vui lòng thử lại sau ít phút.');
      return PaymentEventResult.ERROR;
    }
  }

  private async claim(msg: InboundTextMessage, actor: ConfirmActor, action?: PaymentEventAction) {
    const dedupKey = msg.messageId
      ? `zalo-msg:${msg.messageId}`
      : `zalo-hash:${createHash('sha256').update(`${msg.fromId}|${msg.date ?? ''}|${msg.text}`).digest('hex')}`;
    try {
      return await this.payments.claimBotMessage(dedupKey, actor, action);
    } catch (err) {
      this.logger.error(`Không ghi nhận được lệnh thanh toán: ${(err as Error).message}`);
      return 'error' as const;
    }
  }

  /** Sends the reply to the admin's chat. A failure is logged, never thrown — the payment state
   * is already persisted and must not be rolled back because Zalo was unreachable. */
  private async reply(msg: InboundTextMessage, text: string): Promise<string> {
    try {
      const res = await this.client.sendMessage(msg.chatId, text);
      if (res.ok) return 'ACCEPTED';
      this.logger.warn(`Không gửi được phản hồi lệnh thanh toán tới ${maskChatId(msg.chatId)}: ${res.errorCode}`);
      return `FAILED:${res.errorCode}`;
    } catch (err) {
      this.logger.warn(`Không gửi được phản hồi lệnh thanh toán: ${(err as Error).message}`);
      return 'FAILED:INTERNAL';
    }
  }
}
