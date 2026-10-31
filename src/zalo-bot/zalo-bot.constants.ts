/** Channel identifier persisted on notification jobs — leaves room for other channels
 * (e.g. the future customer-facing ZBS/OA notifications) without sharing state with them. */
export const ZALO_BOT_CHANNEL = 'ZALO_BOT';

export enum NotificationEventType {
  ORDER_CREATED = 'ORDER_CREATED',
  /** Customer asked to cancel an order that is already PROCESSING (they can no longer cancel
   * it themselves) — the owner must handle it in the admin dashboard. */
  ORDER_CANCEL_REQUESTED = 'ORDER_CANCEL_REQUESTED',
  /** Customer cancelled a PENDING order themselves — informational for the owner. */
  ORDER_CANCELLED_BY_CUSTOMER = 'ORDER_CANCELLED_BY_CUSTOMER',
  /** Customer asked to return/refund a delivered order — the owner must review it in the
   * admin dashboard ("Trả hàng / Hoàn tiền"). */
  ORDER_RETURN_REQUESTED = 'ORDER_RETURN_REQUESTED',
  /** Customer asked for a VAT e-invoice (at checkout or later) — the owner must accept or
   * reject it in the admin dashboard before the order ships. */
  EINVOICE_REQUESTED = 'EINVOICE_REQUESTED',
}

/** Owner Bot events that travel through the Order outbox (`pendingNotificationEvents`). */
export const ZALO_BOT_OUTBOX_EVENTS: NotificationEventType[] = [
  NotificationEventType.ORDER_CREATED,
  NotificationEventType.ORDER_CANCEL_REQUESTED,
  NotificationEventType.ORDER_CANCELLED_BY_CUSTOMER,
  NotificationEventType.ORDER_RETURN_REQUESTED,
  NotificationEventType.EINVOICE_REQUESTED,
];

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
  // ── Used by the customer-facing ZBS channel only (src/zalo-zbs) ──
  /** Provider delivery evidence (ZBS message-status API says the phone received it). */
  DELIVERED = 'DELIVERED',
  /** Order phone missing / malformed, or Zalo answered "phone number invalid". */
  SKIPPED_INVALID_RECIPIENT = 'SKIPPED_INVALID_RECIPIENT',
  /** Zalo refused this recipient (no Zalo account, opted out, delivery policy) or the order
   * is no longer eligible (cancelled before sending). */
  SKIPPED_INELIGIBLE = 'SKIPPED_INELIGIBLE',
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
