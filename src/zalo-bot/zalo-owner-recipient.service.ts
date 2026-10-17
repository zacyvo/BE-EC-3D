import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ZaloBotConfigService } from './zalo-bot.config';
import { MAX_PENDING_RECIPIENTS } from './zalo-bot.constants';
import {
  ZaloBotRecipient,
  ZaloBotRecipientDocument,
  ZaloBotRecipientStatus,
} from './schemas/zalo-bot-recipient.schema';
import { AuditService } from '../audit/audit.service';

export interface ApprovedRecipient {
  chatId: string;
  source: 'ENV' | 'DB';
  label?: string;
}

export interface InboundChat {
  chatId: string;
  chatType?: string;
  displayName?: string;
}

export type InboundChatOutcome = 'created' | 'updated' | 'ignored_limit';

/** "1234567890123456789" → "123…6789" — enough for an admin to tell chats apart. */
export function maskChatId(chatId: string): string {
  const s = String(chatId ?? '');
  if (s.length <= 8) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/**
 * Who is allowed to receive owner notifications:
 *   ENV  — ZALO_OWNER_CHAT_IDS (simplest setup, no admin UI needed)
 *   DB   — chats discovered via webhook AND explicitly approved by a SUPER_ADMIN
 * A chat that merely messaged the bot is PENDING and never receives anything.
 */
@Injectable()
export class ZaloOwnerRecipientService {
  private readonly logger = new Logger(ZaloOwnerRecipientService.name);

  constructor(
    @InjectModel(ZaloBotRecipient.name) private readonly recipientModel: Model<ZaloBotRecipientDocument>,
    private readonly configService: ZaloBotConfigService,
    private readonly auditService: AuditService,
  ) {}

  async getApprovedRecipients(): Promise<ApprovedRecipient[]> {
    const envIds = this.configService.get().ownerChatIds;
    const out: ApprovedRecipient[] = envIds.map((chatId) => ({ chatId, source: 'ENV' as const }));
    const dbRows = await this.recipientModel
      .find({ status: ZaloBotRecipientStatus.APPROVED })
      .sort({ approvedAt: 1 })
      .lean()
      .exec();
    for (const row of dbRows) {
      if (!envIds.includes(row.chatId)) {
        out.push({ chatId: row.chatId, source: 'DB', label: row.displayName });
      }
    }
    return out;
  }

  async isApproved(chatId: string): Promise<boolean> {
    if (this.configService.get().ownerChatIds.includes(chatId)) return true;
    return !!(await this.recipientModel.exists({ chatId, status: ZaloBotRecipientStatus.APPROVED }).exec());
  }

  /**
   * Webhook enrollment step: remember the chat as PENDING (or refresh lastSeenAt). Idempotent
   * — re-delivered events just update the same row — and NEVER changes status, so a stranger
   * can't promote themselves. New chats are dropped once MAX_PENDING_RECIPIENTS is reached.
   */
  async recordInboundChat(chat: InboundChat): Promise<InboundChatOutcome> {
    const now = new Date();
    const displayName = chat.displayName ? chat.displayName.slice(0, 100) : undefined;
    const existing = await this.recipientModel.findOne({ chatId: chat.chatId }).exec();
    if (existing) {
      await this.recipientModel
        .updateOne(
          { _id: existing._id },
          { $set: { lastSeenAt: now, ...(displayName ? { displayName } : {}), ...(chat.chatType ? { chatType: chat.chatType } : {}) } },
        )
        .exec();
      return 'updated';
    }

    const pending = await this.recipientModel.countDocuments({ status: ZaloBotRecipientStatus.PENDING }).exec();
    if (pending >= MAX_PENDING_RECIPIENTS) {
      this.logger.warn(`Bỏ qua chat mới ${maskChatId(chat.chatId)} — đã đủ ${MAX_PENDING_RECIPIENTS} chat chờ duyệt`);
      return 'ignored_limit';
    }

    try {
      await this.recipientModel.create({
        chatId: chat.chatId,
        chatType: chat.chatType,
        displayName,
        status: ZaloBotRecipientStatus.PENDING,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      this.logger.log(`Ghi nhận chat Zalo mới chờ duyệt: ${maskChatId(chat.chatId)}`);
      return 'created';
    } catch (err) {
      // Concurrent duplicate delivery of the same event — the other request created the row.
      if ((err as { code?: number }).code === 11000) return 'updated';
      throw err;
    }
  }

  /** Admin view. Chat ids are masked; actions use the row id (or "env:<index>"). */
  async listForAdmin() {
    const envIds = this.configService.get().ownerChatIds;
    const rows = await this.recipientModel.find().sort({ lastSeenAt: -1 }).lean().exec();
    return {
      env: envIds.map((chatId, index) => ({
        key: `env:${index}`,
        chatIdMasked: maskChatId(chatId),
        status: ZaloBotRecipientStatus.APPROVED,
        source: 'ENV' as const,
      })),
      discovered: rows.map((r) => ({
        key: r._id.toString(),
        chatIdMasked: maskChatId(r.chatId),
        chatType: r.chatType,
        displayName: r.displayName,
        status: r.status,
        source: 'DB' as const,
        alsoInEnv: envIds.includes(r.chatId),
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        approvedAt: r.approvedAt,
        revokedAt: r.revokedAt,
      })),
    };
  }

  async approve(id: string, staffId: string) {
    return this.setStatus(id, ZaloBotRecipientStatus.APPROVED, staffId);
  }

  async revoke(id: string, staffId: string) {
    return this.setStatus(id, ZaloBotRecipientStatus.REVOKED, staffId);
  }

  /** Resolves an admin-facing key to an APPROVED chat id (used by the test-message action). */
  async resolveApprovedKey(key: string): Promise<ApprovedRecipient> {
    if (key.startsWith('env:')) {
      const idx = Number(key.slice(4));
      const chatId = this.configService.get().ownerChatIds[idx];
      if (!Number.isInteger(idx) || !chatId) throw new NotFoundException('Không tìm thấy người nhận');
      return { chatId, source: 'ENV' };
    }
    if (!Types.ObjectId.isValid(key)) throw new BadRequestException('Mã người nhận không hợp lệ');
    const row = await this.recipientModel.findById(key).lean().exec();
    if (!row) throw new NotFoundException('Không tìm thấy người nhận');
    if (row.status !== ZaloBotRecipientStatus.APPROVED) {
      throw new BadRequestException('Chỉ gửi thử được tới người nhận đã duyệt');
    }
    return { chatId: row.chatId, source: 'DB', label: row.displayName };
  }

  private async setStatus(id: string, status: ZaloBotRecipientStatus, staffId: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Mã người nhận không hợp lệ');
    const row = await this.recipientModel.findById(id).exec();
    if (!row) throw new NotFoundException('Không tìm thấy người nhận');
    const before = row.status;
    const now = new Date();
    row.status = status;
    if (status === ZaloBotRecipientStatus.APPROVED) {
      row.approvedBy = staffId;
      row.approvedAt = now;
    } else {
      row.revokedBy = staffId;
      row.revokedAt = now;
    }
    await row.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: status === ZaloBotRecipientStatus.APPROVED ? 'ZALO_BOT_RECIPIENT_APPROVE' : 'ZALO_BOT_RECIPIENT_REVOKE',
      module: 'zalo-bot',
      targetId: id,
      beforeData: { status: before },
      afterData: { status, chatIdMasked: maskChatId(row.chatId) },
    });
    this.logger.log(`Chat ${maskChatId(row.chatId)}: ${before} → ${status} (bởi ${staffId})`);
    return { key: id, status, chatIdMasked: maskChatId(row.chatId) };
  }
}
