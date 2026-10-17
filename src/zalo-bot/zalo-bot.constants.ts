/** Channel identifier persisted on notification jobs — leaves room for other channels
 * (e.g. the future customer-facing ZBS/OA notifications) without sharing state with them. */
export const ZALO_BOT_CHANNEL = 'ZALO_BOT';

export enum NotificationEventType {
  ORDER_CREATED = 'ORDER_CREATED',
}

/**
 * Lifecycle of one notification job (= one event × one channel × one recipient).
 *
 * ACCEPTED means the Zalo Bot API answered `ok: true` for sendMessage — it is NOT proof
 * the owner actually saw the message (the Bot API exposes no delivery receipts).
 * UNKNOWN means the request may or may not have reached Zalo (timeout, connection reset,
 * worker crash mid-send); it is never retried automatically to avoid duplicate messages.
 */
export enum NotificationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  ACCEPTED = 'ACCEPTED',
  RETRY_PENDING = 'RETRY_PENDING',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  SKIPPED_NOT_CONFIGURED = 'SKIPPED_NOT_CONFIGURED',
}

/** recipientId used for the single placeholder job recorded when an order event could
 * not be fanned out because no approved recipient / valid config existed at that time. */
export const NO_RECIPIENT_PLACEHOLDER = '__none__';

/** Zalo Bot sendMessage `text` limit (docs.zaloplatforms.com/docs/BOT/apis/sendMessage). */
export const ZALO_MESSAGE_MIN_LENGTH = 1;
export const ZALO_MESSAGE_MAX_LENGTH = 2000;

/** Header Zalo sends on every webhook call, carrying the `secret_token` given to setWebhook. */
export const ZALO_WEBHOOK_SECRET_HEADER = 'x-bot-api-secret-token';

/** Upper bound on not-yet-approved chats kept from webhook events — anyone can message the
 * bot, so this stops a stranger from filling the collection. Owners only need one row. */
export const MAX_PENDING_RECIPIENTS = 20;
