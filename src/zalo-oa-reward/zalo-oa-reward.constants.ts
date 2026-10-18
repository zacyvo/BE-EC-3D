/**
 * Luxe Glow Zalo OA welcome reward: shared constants.
 * Separate from the Zalo Bot (owner notifications) and ZBS (order confirmation) modules.
 * See docs/ZALO_OA_REWARD_INTEGRATION.md.
 */

/** Backend-authoritative state of one reward session (one per storefront order). There is
 * deliberately no linking-code or OTP state: identity comes only from a verified Zalo
 * login and a signed OA follow event. */
export enum RewardSessionState {
  /** Session exists, offer can be shown, the customer has not opened Zalo yet. */
  ELIGIBLE = 'ELIGIBLE',
  /** A personalized connect link/QR was issued and is waiting to be opened. */
  AWAITING_ZALO = 'AWAITING_ZALO',
  /** The customer opened the link; Zalo authorization is in progress. */
  IDENTITY_PENDING = 'IDENTITY_PENDING',
  /** Zalo identity verified server-side; waiting for the signed OA follow event. */
  FOLLOW_PENDING = 'FOLLOW_PENDING',
  /** OA UID resolved from a signed follow event and bound to this session. */
  LINKED = 'LINKED',
  REWARD_PROCESSING = 'REWARD_PROCESSING',
  REWARD_ASSIGNED = 'REWARD_ASSIGNED',
  ALREADY_CLAIMED = 'ALREADY_CLAIMED',
  NOT_ELIGIBLE = 'NOT_ELIGIBLE',
  /** No trustworthy session → OA UID mapping could be established (e.g. the Zalo account
   * already followed the OA before, so Zalo sends no follow event). Never a fake success. */
  UNSUPPORTED_LINKING = 'UNSUPPORTED_LINKING',
  EXPIRED = 'EXPIRED',
  ERROR = 'ERROR',
}

/** States after which nothing more happens automatically. */
export const TERMINAL_STATES: ReadonlySet<RewardSessionState> = new Set([
  RewardSessionState.REWARD_ASSIGNED,
  RewardSessionState.ALREADY_CLAIMED,
  RewardSessionState.NOT_ELIGIBLE,
  RewardSessionState.UNSUPPORTED_LINKING,
  RewardSessionState.ERROR,
]);

/** States in which a new connect link may be issued (re-opening the modal). */
export const LINKABLE_STATES: ReadonlySet<RewardSessionState> = new Set([
  RewardSessionState.ELIGIBLE,
  RewardSessionState.AWAITING_ZALO,
  RewardSessionState.IDENTITY_PENDING,
  RewardSessionState.EXPIRED,
]);

export enum IdentitySource {
  /** Zalo Login on the web (Social API, OAuth v4 + PKCE). */
  SOCIAL_LOGIN = 'SOCIAL_LOGIN',
  /** Zalo Mini App getAccessToken → server-side /me. */
  MINI_APP = 'MINI_APP',
}

export enum LinkMode {
  SOCIAL_LOGIN = 'social_login',
  MINI_APP = 'mini_app',
}

/** Where the phone stored with a reward association came from. Never "verified". */
export enum RewardPhoneSource {
  /** Typed by the customer in the reward modal (optional field). */
  REWARD_INPUT = 'REWARD_INPUT',
  /** The phone already on the logged-in account that placed the order. */
  ACCOUNT = 'ACCOUNT',
  NONE = 'NONE',
}

export enum RecipientResolution {
  /** Case A/D: the OA UID was already associated with a user — that association wins. */
  EXISTING_OA_LINK = 'EXISTING_OA_LINK',
  /** Default: the authenticated account that placed the order. */
  SESSION_ACCOUNT = 'SESSION_ACCOUNT',
  /** Case B: the optional reward phone matches an existing user (unverified association). */
  PHONE_MATCH = 'PHONE_MATCH',
  /** Case C: the optional reward phone is unknown → a Guest user was created. */
  GUEST_BY_PHONE = 'GUEST_BY_PHONE',
  /** No account and no phone → a UID-keyed Guest (only reachable without a session owner). */
  GUEST_BY_UID = 'GUEST_BY_UID',
}

export enum GrantStatus {
  PROCESSING = 'PROCESSING',
  ASSIGNED = 'ASSIGNED',
}

/** Why a session/order cannot get the reward. Returned to the owner; contains no PII. */
export enum IneligibleReason {
  DISABLED = 'DISABLED',
  CONFIG_INVALID = 'CONFIG_INVALID',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  ORDER_NOT_STOREFRONT = 'ORDER_NOT_STOREFRONT',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_TOO_OLD = 'ORDER_TOO_OLD',
  PROMOTION_NOT_FOUND = 'PROMOTION_NOT_FOUND',
  PROMOTION_INACTIVE = 'PROMOTION_INACTIVE',
  PROMOTION_NOT_STARTED = 'PROMOTION_NOT_STARTED',
  PROMOTION_EXPIRED = 'PROMOTION_EXPIRED',
  COUPON_NOT_IN_PROMOTION = 'COUPON_NOT_IN_PROMOTION',
  DISCOUNT_MISMATCH = 'DISCOUNT_MISMATCH',
  COUPON_EXHAUSTED = 'COUPON_EXHAUSTED',
  RECIPIENT_BLOCKED = 'RECIPIENT_BLOCKED',
}

/** The business requirement this campaign is built for. The DB value is what is displayed
 * and applied; a mismatch makes the campaign ineligible instead of advertising a wrong %. */
export const EXPECTED_DISCOUNT_PERCENT = 20;

/** Zalo's OA webhook signature header: mac = sha256(appId + data + timeStamp + OAsecretKey). */
export const ZALO_OA_SIGNATURE_HEADER = 'x-zevent-signature';

/** Raw request body captured by main.ts for this path only (signature needs exact bytes). */
export const ZALO_OA_WEBHOOK_PATH = '/api/v1/webhooks/zalo-oa';

export function maskId(id: string | undefined | null): string {
  const s = String(id ?? '');
  if (!s) return '—';
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}***${s.slice(-3)}`;
}
