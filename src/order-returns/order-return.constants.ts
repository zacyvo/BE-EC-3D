import { ReturnReason, ReturnStatus } from '../orders/schemas/order.schema';

/** The customer may ask for a return within this many days after the order was delivered. */
export const RETURN_WINDOW_DAYS = 7;
export const RETURN_WINDOW_MS = RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const RETURN_MAX_IMAGES = 5;

/** Statuses in which the customer can still withdraw the request (parcel not sent yet). */
export const USER_CANCELLABLE_RETURN_STATUSES = [ReturnStatus.REQUESTED, ReturnStatus.APPROVED];
/** Statuses in which the customer can enter / correct the return tracking code. */
export const USER_SHIPPABLE_RETURN_STATUSES = [ReturnStatus.APPROVED, ReturnStatus.SHIPPING_BACK];
/** Statuses in which the shop can confirm the parcel arrived (also from APPROVED: the customer
 * may drop it off at the shop without entering a tracking code). */
export const RECEIVABLE_RETURN_STATUSES = [ReturnStatus.APPROVED, ReturnStatus.SHIPPING_BACK];
/** Request still needs someone to act — counted in the admin badge. */
export const OPEN_RETURN_STATUSES = [
  ReturnStatus.REQUESTED,
  ReturnStatus.APPROVED,
  ReturnStatus.SHIPPING_BACK,
  ReturnStatus.RECEIVED,
  ReturnStatus.REFUNDING,
];

/** Reasons that are the shop's fault — the policy reimburses return shipping for these. */
export const SHOP_FAULT_RETURN_REASONS = [
  ReturnReason.DAMAGED,
  ReturnReason.DEFECTIVE,
  ReturnReason.WRONG_ITEM,
  ReturnReason.MISSING_PARTS,
  ReturnReason.NOT_AS_DESCRIBED,
];
