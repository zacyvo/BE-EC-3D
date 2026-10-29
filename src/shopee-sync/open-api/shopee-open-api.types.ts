/**
 * Response shapes of the Shopee Open Platform v2 endpoints this module calls. Every field
 * is optional on purpose: the mappers must survive a missing/renamed field (fall back to
 * a safe default or fail ONE product/order) instead of crashing a whole sync job.
 * Field names follow the v2 API reference on open.shopee.com — re-verify against a real
 * response (sandbox or live) when Shopee announces an API change.
 */

export interface ShopeeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Seconds (access token ≈ 4h). */
  expire_in?: number;
  shop_id?: number;
  shop_id_list?: number[];
  merchant_id_list?: number[];
}

export interface ShopeeShopInfo {
  shop_name?: string;
  region?: string;
  status?: string;
  /** Unix seconds — when this app's authorization for the shop expires (≈ 1 year). */
  expire_time?: number;
  auth_time?: number;
}

// ─── Product ────────────────────────────────────────────────────────────────

export type ShopeeItemStatus = 'NORMAL' | 'BANNED' | 'UNLIST' | 'REVIEWING' | 'SELLER_DELETE' | 'SHOPEE_DELETE';

export interface ShopeeItemListResponse {
  item?: { item_id?: number; item_status?: ShopeeItemStatus; update_time?: number }[];
  total_count?: number;
  has_next_page?: boolean;
  next_offset?: number;
}

export interface ShopeePriceInfo {
  currency?: string;
  original_price?: number;
  current_price?: number;
}

export interface ShopeeStockInfoV2 {
  summary_info?: { total_reserved_stock?: number; total_available_stock?: number };
  seller_stock?: { location_id?: string; stock?: number }[];
  shopee_stock?: { location_id?: string; stock?: number }[];
}

export interface ShopeeItemBaseInfo {
  item_id?: number;
  category_id?: number;
  item_name?: string;
  description?: string;
  description_type?: 'normal' | 'extended' | string;
  description_info?: {
    extended_description?: {
      field_list?: { field_type?: 'text' | 'image' | string; text?: string; image_info?: { image_id?: string; image_url?: string } }[];
    };
  };
  item_sku?: string;
  create_time?: number;
  update_time?: number;
  price_info?: ShopeePriceInfo[];
  stock_info_v2?: ShopeeStockInfoV2;
  image?: { image_url_list?: string[]; image_id_list?: string[] };
  /** Kilograms, as a decimal string (e.g. "0.6"). */
  weight?: string | number;
  dimension?: { package_length?: number; package_width?: number; package_height?: number };
  pre_order?: { is_pre_order?: boolean; days_to_ship?: number };
  condition?: 'NEW' | 'USED' | string;
  item_status?: ShopeeItemStatus;
  has_model?: boolean;
  brand?: { brand_id?: number; original_brand_name?: string };
  video_info?: { video_url?: string; thumbnail_url?: string; duration?: number }[];
}

export interface ShopeeItemBaseInfoResponse {
  item_list?: ShopeeItemBaseInfo[];
}

export interface ShopeeModelListResponse {
  tier_variation?: { name?: string; option_list?: { option?: string; image?: { image_id?: string; image_url?: string } }[] }[];
  model?: {
    model_id?: number;
    tier_index?: number[];
    model_sku?: string;
    model_status?: string;
    price_info?: ShopeePriceInfo[];
    stock_info_v2?: ShopeeStockInfoV2;
    pre_order?: { is_pre_order?: boolean; days_to_ship?: number };
  }[];
}

export interface ShopeeItemExtraInfo {
  item_id?: number;
  sale?: number;
  views?: number;
  likes?: number;
}

export interface ShopeeItemExtraInfoResponse {
  item_list?: ShopeeItemExtraInfo[];
}

// ─── Order ──────────────────────────────────────────────────────────────────

export type ShopeeApiOrderStatus =
  | 'UNPAID'
  | 'READY_TO_SHIP'
  | 'PROCESSED'
  | 'RETRY_SHIP'
  | 'SHIPPED'
  | 'TO_CONFIRM_RECEIVE'
  | 'IN_CANCEL'
  | 'CANCELLED'
  | 'TO_RETURN'
  | 'COMPLETED'
  | 'INVOICE_PENDING';

export interface ShopeeOrderListResponse {
  more?: boolean;
  next_cursor?: string;
  order_list?: { order_sn?: string; order_status?: ShopeeApiOrderStatus }[];
}

export interface ShopeeOrderItem {
  item_id?: number;
  item_name?: string;
  item_sku?: string;
  model_id?: number;
  model_name?: string;
  model_sku?: string;
  model_quantity_purchased?: number;
  model_original_price?: number;
  model_discounted_price?: number;
}

export interface ShopeeOrderDetail {
  order_sn?: string;
  order_status?: ShopeeApiOrderStatus;
  create_time?: number;
  update_time?: number;
  pay_time?: number;
  total_amount?: number;
  currency?: string;
  message_to_seller?: string;
  note?: string;
  buyer_user_id?: number;
  buyer_username?: string;
  shipping_carrier?: string;
  estimated_shipping_fee?: number;
  actual_shipping_fee?: number;
  cancel_reason?: string;
  recipient_address?: {
    name?: string;
    phone?: string;
    town?: string;
    district?: string;
    city?: string;
    state?: string;
    region?: string;
    zipcode?: string;
    full_address?: string;
  };
  item_list?: ShopeeOrderItem[];
  package_list?: { package_number?: string; logistics_status?: string; shipping_carrier?: string }[];
}

export interface ShopeeOrderDetailResponse {
  order_list?: ShopeeOrderDetail[];
}

export interface ShopeeTrackingNumberResponse {
  tracking_number?: string;
}

/** payment/get_escrow_detail — the per-order settlement Shopee pays the seller. */
export interface ShopeeEscrowDetailResponse {
  order_sn?: string;
  return_order_sn_list?: string[];
  order_income?: {
    /** What the seller actually receives after every fee/tax/subsidy. */
    escrow_amount?: number;
    buyer_total_amount?: number;
    buyer_paid_shipping_fee?: number;
    actual_shipping_fee?: number;
    shopee_shipping_rebate?: number;
    commission_fee?: number;
    service_fee?: number;
    seller_transaction_fee?: number;
    escrow_tax?: number;
  };
}
