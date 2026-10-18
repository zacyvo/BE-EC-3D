import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ZaloOaRewardConfigService } from './zalo-oa-reward.config';
import { maskId } from './zalo-oa-reward.constants';
import { sha256Hex, verifyOaWebhookSignature } from './zalo-oa-crypto';
import { ZaloOaRewardService } from './zalo-oa-reward.service';
import { ZaloOaFollower, ZaloOaFollowerDocument } from './schemas/zalo-oa-follower.schema';
import { ZaloOaWebhookEvent, ZaloOaWebhookEventDocument } from './schemas/zalo-oa-webhook-event.schema';

export interface FollowEvent {
  eventName: 'follow' | 'unfollow';
  oaId: string;
  appId: string;
  oaUid: string;
  userIdByApp: string;
  source?: string;
  timestamp: Date;
}

export type WebhookOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED_EVENT'
  | 'IGNORED_OA'
  | 'IGNORED_STALE'
  | 'IGNORED_MALFORMED';

const ZALO_ID = /^\d{5,32}$/;
const FUTURE_SKEW_MS = 5 * 60_000;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** Documented follow/unfollow payload (docs.zaloplatforms.com/docs/OA/webhook/quan-ly/
 * su-kien-nguoi-dung-quan-tam-hay-bo-quan-tam-oa):
 *   { oa_id, follower: { id }, user_id_by_app, event_name: "follow"|"unfollow", source, app_id, timestamp }
 * Returns null for any other event or a malformed one. */
export function parseFollowEvent(body: Record<string, unknown>): FollowEvent | null {
  const eventName = str(body.event_name);
  if (eventName !== 'follow' && eventName !== 'unfollow') return null;
  const follower = body.follower && typeof body.follower === 'object' ? (body.follower as Record<string, unknown>) : {};
  const oaUid = str(follower.id);
  const userIdByApp = str(body.user_id_by_app);
  const oaId = str(body.oa_id);
  const appId = str(body.app_id);
  const tsMs = Number(str(body.timestamp));
  if (!ZALO_ID.test(oaUid) || !ZALO_ID.test(userIdByApp) || !ZALO_ID.test(oaId) || !ZALO_ID.test(appId)) return null;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  const source = str(body.source).slice(0, 40) || undefined;
  return { eventName, oaId, appId, oaUid, userIdByApp, source, timestamp: new Date(tsMs) };
}

/**
 * ZaloOaWebhookHandler. Separate from the Zalo Bot webhook (different URL, different secret).
 * Only follow/unfollow events are used, and only to maintain the app-scoped-id → OA UID map.
 * A follow event NEVER links or rewards anything by itself: a session must already hold a
 * server-verified Zalo identity with the same app-scoped id.
 */
@Injectable()
export class ZaloOaWebhookService {
  private readonly logger = new Logger(ZaloOaWebhookService.name);

  constructor(
    @InjectModel(ZaloOaFollower.name) private readonly followerModel: Model<ZaloOaFollowerDocument>,
    @InjectModel(ZaloOaWebhookEvent.name) private readonly eventModel: Model<ZaloOaWebhookEventDocument>,
    private readonly config: ZaloOaRewardConfigService,
    private readonly rewards: ZaloOaRewardService,
  ) {}

  async handle(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ ok: true; outcome: WebhookOutcome }> {
    const cfg = this.config.get();
    if (!this.config.webhookReady(cfg)) {
      this.logger.warn('Webhook Zalo OA bị gọi nhưng ZALO_OA_WEBHOOK_SECRET/APP_ID/ID chưa cấu hình');
      throw new ServiceUnavailableException('Webhook not configured');
    }
    if (!rawBody?.length) throw new BadRequestException('Empty body');
    const raw = rawBody.toString('utf8');
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Malformed JSON');
    }

    const ok = verifyOaWebhookSignature({
      header: signature,
      appId: cfg.appId,
      rawBody: raw,
      timestamp: str(body.timestamp),
      oaSecretKey: cfg.webhookSecret,
    });
    if (!ok) {
      this.logger.warn(`Webhook Zalo OA: chữ ký không hợp lệ (header ${signature ? 'có' : 'thiếu'}) — từ chối`);
      throw new UnauthorizedException('Invalid signature');
    }
    if (str(body.app_id) && str(body.app_id) !== cfg.appId) {
      this.logger.warn('Webhook Zalo OA: app_id không khớp ZALO_OA_APP_ID — từ chối');
      throw new UnauthorizedException('Unexpected app');
    }

    const eventName = str(body.event_name);
    if (eventName !== 'follow' && eventName !== 'unfollow') return { ok: true, outcome: 'IGNORED_EVENT' };
    const evt = parseFollowEvent(body);
    if (!evt) {
      this.logger.warn(`Webhook Zalo OA: sự kiện ${eventName} sai định dạng (keys=[${Object.keys(body).join(',')}])`);
      return { ok: true, outcome: 'IGNORED_MALFORMED' };
    }
    if (evt.oaId !== cfg.oaId) return { ok: true, outcome: 'IGNORED_OA' };

    const age = Date.now() - evt.timestamp.getTime();
    if (age > cfg.webhookMaxAgeSeconds * 1000 || age < -FUTURE_SKEW_MS) {
      this.logger.warn(`Webhook Zalo OA: sự kiện ${evt.eventName} quá cũ/tương lai (${Math.round(age / 1000)}s) — bỏ qua`);
      return { ok: true, outcome: 'IGNORED_STALE' };
    }

    // Claim the delivery first (Zalo retries with identical content).
    const eventKey = sha256Hex(raw);
    try {
      await this.eventModel.create({ eventKey, eventName: evt.eventName, oaUid: evt.oaUid, providerTimestamp: evt.timestamp, outcome: 'APPLIED' });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return { ok: true, outcome: 'DUPLICATE' };
      throw err;
    }

    try {
      const applied = await this.applyFollowEvent(evt);
      if (!applied) await this.eventModel.updateOne({ eventKey }, { $set: { outcome: 'IGNORED_STALE' } });
      if (applied && evt.eventName === 'follow') {
        // Respond to Zalo within its 2 s budget; correlation runs right after.
        setImmediate(() => {
          this.rewards
            .onFollowerUpdated({ userIdByApp: evt.userIdByApp, isFollower: true })
            .catch((err) => this.logger.error(`Zalo OA reward: xử lý sau follow lỗi: ${(err as Error).message}`));
        });
      }
      return { ok: true, outcome: applied ? 'APPLIED' : 'IGNORED_STALE' };
    } catch (err) {
      // Release the claim so Zalo's retry can be processed.
      await this.eventModel.deleteOne({ eventKey }).catch(() => undefined);
      throw err;
    }
  }

  /** Upsert keyed by (oaId, appId, userIdByApp); an older delivery never overwrites a newer one. */
  async applyFollowEvent(evt: FollowEvent): Promise<boolean> {
    const isFollower = evt.eventName === 'follow';
    try {
      const res = await this.followerModel.updateOne(
        {
          oaId: evt.oaId,
          appId: evt.appId,
          userIdByApp: evt.userIdByApp,
          $or: [{ lastEventAt: { $lt: evt.timestamp } }, { lastEventAt: { $exists: false } }],
        },
        {
          $set: {
            oaUid: evt.oaUid,
            isFollower,
            lastEventAt: evt.timestamp,
            ...(evt.source ? { lastSource: evt.source } : {}),
            ...(isFollower ? { followedAt: evt.timestamp } : { unfollowedAt: evt.timestamp }),
          },
        },
        { upsert: true },
      );
      this.logger.log(`Webhook Zalo OA: ${evt.eventName} OA UID ${maskId(evt.oaUid)} (${evt.source ?? '—'})`);
      return res.modifiedCount + res.upsertedCount > 0;
    } catch (err) {
      // The filter missed because a newer event is stored → the upsert collides → stale.
      if ((err as { code?: number })?.code === 11000) return false;
      throw err;
    }
  }
}
