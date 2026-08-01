import { Injectable, HttpStatus } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ShopeeOrderSyncBatch,
  ShopeeOrderSyncBatchDocument,
  ShopeeOrderRowResult,
  ShopeeOrderRowStatus,
} from './schemas/shopee-order-sync-batch.schema';
import {
  ShopeeOrderSyncIssue,
  ShopeeOrderSyncIssueDocument,
  ShopeeOrderIssueStatus,
  ShopeeOrderIssueItem,
} from './schemas/shopee-order-sync-issue.schema';
import { OrdersService, ImportExternalOrderInput, ExternalOrderItemInput } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../audit/audit.service';
import { ShopeeSyncConfigService } from './shopee-sync.config';
import { ShopeeSyncException } from './shopee-sync.exceptions';
import { ShopeeSyncErrorCode, SHOPEE_SYNC_AUDIT_MODULE } from './shopee-sync.constants';
import {
  SHOPEE_ORDER_COLUMNS,
  ShopeeOrderRawRow,
  parseShopeeOrderWorkbook,
  groupRowsByOrderCode,
  parseVndAmount,
  parseShopeeDate,
  mapShopeeOrderStatus,
  isMasked,
  isValidVnMobile,
  normalizeVnPhone,
  buildShippingPreviewFromGroup,
  computeOrderMoney,
  findBestProductMatches,
  matchVariantToColorOrSize,
  AUTO_MATCH_SCORE,
} from './shopee-order-mapping.util';

const CHANNEL = 'SHOPEE';

interface ProductForMatching {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  images: string[];
  colors: { name: string; images: string[] }[];
  sizes: string[];
}

@Injectable()
export class ShopeeOrderSyncService {
  constructor(
    @InjectModel(ShopeeOrderSyncBatch.name) private readonly batchModel: Model<ShopeeOrderSyncBatchDocument>,
    @InjectModel(ShopeeOrderSyncIssue.name) private readonly issueModel: Model<ShopeeOrderSyncIssueDocument>,
    private readonly ordersService: OrdersService,
    private readonly productsService: ProductsService,
    private readonly auditService: AuditService,
    private readonly shopeeSyncConfigService: ShopeeSyncConfigService,
  ) {}

  async importWorkbook(buffer: Buffer, fileName: string, staffId: string): Promise<ShopeeOrderSyncBatchDocument> {
    if (!this.shopeeSyncConfigService.get().enabled) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.SHOPEE_SYNC_DISABLED, 'Đồng bộ Shopee hiện đang tắt');
    }

    const rows = parseShopeeOrderWorkbook(buffer);
    const groups = groupRowsByOrderCode(rows);

    const productsResult = await this.productsService.findAll({ page: 1, limit: 5000, forAdmin: true });
    const productList = productsResult.data as unknown as ProductForMatching[];
    const productIndex = productList.map((p) => ({ id: p._id.toString(), name: p.name }));
    const productById = new Map(productList.map((p) => [p._id.toString(), p]));

    const batch = await this.batchModel.create({
      fileName,
      uploadedBy: new Types.ObjectId(staffId),
      totalRows: rows.length,
      totalOrders: groups.size,
      rows: [],
    });

    const rowResults: ShopeeOrderRowResult[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let needsReviewCount = 0;
    let dismissedCount = 0;
    let failedCount = 0;

    for (const [orderCode, groupRows] of groups) {
      try {
        const existingOrder = await this.ordersService.findByExternalRef(CHANNEL, orderCode);
        if (existingOrder) {
          const nonItemFields = this.buildNonItemFields(orderCode, groupRows);
          // Items are never touched on the update path (see OrdersService.applyExternalOrderUpdate) — [] is a safe no-op.
          await this.ordersService.importExternalOrder({ ...nonItemFields, items: [], staffId });
          await this.resolveLingeringIssue(orderCode, existingOrder._id, batch._id);
          updatedCount++;
          rowResults.push({ orderCode, status: ShopeeOrderRowStatus.UPDATED, orderId: existingOrder._id } as ShopeeOrderRowResult);
          continue;
        }

        const existingIssue = await this.issueModel.findOne({ orderCode }).exec();
        if (existingIssue?.status === ShopeeOrderIssueStatus.DISMISSED) {
          dismissedCount++;
          rowResults.push({
            orderCode,
            status: ShopeeOrderRowStatus.DISMISSED,
            message: 'Đơn này đã được bỏ qua trước đó — không tạo lại tự động',
            issueId: existingIssue._id,
          } as ShopeeOrderRowResult);
          continue;
        }

        const { items, issueItems, reasons, allMatched } = this.matchGroupItems(groupRows, productIndex, productById);

        if (allMatched) {
          const nonItemFields = this.buildNonItemFields(orderCode, groupRows);
          const { order } = await this.ordersService.importExternalOrder({ ...nonItemFields, items, staffId });
          if (existingIssue) {
            existingIssue.status = ShopeeOrderIssueStatus.RESOLVED;
            existingIssue.resolvedOrderId = order._id;
            existingIssue.lastBatchId = batch._id;
            await existingIssue.save();
          }
          createdCount++;
          rowResults.push({ orderCode, status: ShopeeOrderRowStatus.CREATED, orderId: order._id } as ShopeeOrderRowResult);
        } else {
          const issue = await this.upsertIssue(orderCode, groupRows, issueItems, reasons, batch._id, existingIssue ?? null);
          needsReviewCount++;
          rowResults.push({
            orderCode,
            status: ShopeeOrderRowStatus.NEEDS_REVIEW,
            message: reasons.join('; '),
            issueId: issue._id,
          } as ShopeeOrderRowResult);
        }
      } catch (err) {
        failedCount++;
        rowResults.push({
          orderCode,
          status: ShopeeOrderRowStatus.FAILED,
          message: err instanceof Error ? err.message : 'Lỗi không xác định',
        } as ShopeeOrderRowResult);
      }
    }

    batch.rows = rowResults;
    batch.createdCount = createdCount;
    batch.updatedCount = updatedCount;
    batch.needsReviewCount = needsReviewCount;
    batch.dismissedCount = dismissedCount;
    batch.failedCount = failedCount;
    await batch.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'IMPORT_SHOPEE_ORDERS_BATCH',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: batch._id.toString(),
    });

    return batch;
  }

  async listBatches(page: number, limit: number) {
    const [data, total] = await Promise.all([
      this.batchModel
        .find()
        .populate('uploadedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.batchModel.countDocuments().exec(),
    ]);
    return { data, total, page, limit };
  }

  async getBatch(id: string): Promise<ShopeeOrderSyncBatchDocument> {
    const batch = await this.batchModel.findById(id).populate('uploadedBy', 'name email').exec();
    if (!batch) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_SYNC_BATCH_NOT_FOUND, 'Không tìm thấy lượt đồng bộ', HttpStatus.NOT_FOUND);
    }
    return batch;
  }

  async listIssues(page: number, limit: number, status?: ShopeeOrderIssueStatus) {
    const filter = { status: status || ShopeeOrderIssueStatus.OPEN };
    const [data, total] = await Promise.all([
      this.issueModel
        .find(filter)
        .sort({ lastSeenAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.issueModel.countDocuments(filter).exec(),
    ]);
    return { data, total, page, limit };
  }

  async getIssue(id: string): Promise<ShopeeOrderSyncIssueDocument> {
    return this.getIssueOrThrow(id);
  }

  /** Resolves a review-queue entry: line items without an explicit mapping fall
   * back to their auto-matched product (if any) — only ambiguous/unmatched lines
   * strictly need an entry in `itemMappings`. */
  async resolveIssue(
    id: string,
    staffId: string,
    itemMappings: { index: number; productId: string }[] = [],
  ): Promise<{ order: Awaited<ReturnType<OrdersService['importExternalOrder']>>['order'] }> {
    const issue = await this.getIssueOrThrow(id);
    if (issue.status !== ShopeeOrderIssueStatus.OPEN) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_SYNC_ISSUE_INVALID_STATE, 'Mục này đã được xử lý trước đó');
    }

    const overrideMap = new Map(itemMappings.map((m) => [m.index, m.productId]));
    const items: ExternalOrderItemInput[] = [];
    for (let i = 0; i < issue.items.length; i++) {
      const item = issue.items[i];
      const productId = overrideMap.get(i) || item.matchedProductId?.toString();
      if (!productId) {
        throw new ShopeeSyncException(
          ShopeeSyncErrorCode.ORDER_SYNC_ISSUE_INVALID_STATE,
          `Thiếu lựa chọn sản phẩm cho dòng #${i + 1} ("${item.productName}")`,
        );
      }
      const product = await this.productsService.findById(productId, true);
      const variant = matchVariantToColorOrSize(item.variantLabel || '', product.colors, product.sizes);
      const image =
        (variant.color && product.colors.find((c) => c.name === variant.color)?.images[0]) || product.images[0] || '';
      items.push({
        productId,
        productName: product.name,
        productImage: image,
        productSlug: product.slug,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.unitPrice * item.quantity,
        ...(variant.color ? { color: variant.color } : {}),
        ...(variant.size ? { size: variant.size } : {}),
        ...(!variant.color && !variant.size && item.variantLabel ? { note: `Phân loại Shopee: ${item.variantLabel}` } : {}),
      });
    }

    const rawRows = issue.rawRows as unknown as ShopeeOrderRawRow[];
    const nonItemFields = this.buildNonItemFields(issue.orderCode, rawRows);
    const { order } = await this.ordersService.importExternalOrder({ ...nonItemFields, items, staffId });

    issue.status = ShopeeOrderIssueStatus.RESOLVED;
    issue.resolvedOrderId = order._id;
    await issue.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'RESOLVE_SHOPEE_ORDER_ISSUE',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: id,
      afterData: { orderId: order._id.toString() },
    });

    return { order };
  }

  async dismissIssue(id: string, staffId: string): Promise<ShopeeOrderSyncIssueDocument> {
    const issue = await this.getIssueOrThrow(id);
    if (issue.status !== ShopeeOrderIssueStatus.OPEN) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_SYNC_ISSUE_INVALID_STATE, 'Mục này đã được xử lý trước đó');
    }
    issue.status = ShopeeOrderIssueStatus.DISMISSED;
    await issue.save();

    await this.auditService.log({
      actorId: staffId,
      actorType: 'staff',
      action: 'DISMISS_SHOPEE_ORDER_ISSUE',
      module: SHOPEE_SYNC_AUDIT_MODULE,
      targetId: id,
    });

    return issue;
  }

  private async getIssueOrThrow(id: string): Promise<ShopeeOrderSyncIssueDocument> {
    const issue = await this.issueModel.findById(id).exec();
    if (!issue) {
      throw new ShopeeSyncException(ShopeeSyncErrorCode.ORDER_SYNC_ISSUE_NOT_FOUND, 'Không tìm thấy mục cần xem lại', HttpStatus.NOT_FOUND);
    }
    return issue;
  }

  /** Everything an ImportExternalOrderInput needs EXCEPT items/staffId — shared by
   * the fresh-import path and resolveIssue() so both stay in sync. */
  private buildNonItemFields(
    orderCode: string,
    rows: ShopeeOrderRawRow[],
  ): Omit<ImportExternalOrderInput, 'items' | 'staffId'> {
    const shippingInfo = buildShippingPreviewFromGroup(rows);
    const money = computeOrderMoney(rows);
    const status = mapShopeeOrderStatus(rows[0][SHOPEE_ORDER_COLUMNS.status]);
    const estimatedDeliveryDate = parseShopeeDate(rows[0][SHOPEE_ORDER_COLUMNS.estimatedDeliveryDate]);
    const carrierName = rows[0][SHOPEE_ORDER_COLUMNS.carrierName]?.trim() || undefined;
    const trackingCode = rows[0][SHOPEE_ORDER_COLUMNS.trackingCode]?.trim() || undefined;
    const packageCode = rows[0][SHOPEE_ORDER_COLUMNS.packageCode]?.trim() || undefined;
    const buyerUsername = rows[0][SHOPEE_ORDER_COLUMNS.buyerUsername]?.trim() || orderCode;
    const orderDate = parseShopeeDate(rows[0][SHOPEE_ORDER_COLUMNS.orderDate]);
    const hasValidPhone = isValidVnMobile(shippingInfo.phone);
    const maskedRecipient =
      isMasked(shippingInfo.recipientName) || isMasked(shippingInfo.phone) || isMasked(shippingInfo.street);

    return {
      channel: CHANNEL,
      code: orderCode,
      ...(packageCode ? { packageCode } : {}),
      shippingInfo,
      subtotal: money.subtotal,
      shippingFee: money.shippingFee,
      discountAmount: money.discountAmount,
      total: money.total,
      status,
      ...(carrierName || trackingCode || estimatedDeliveryDate ? { delivery: { carrierName, trackingCode, estimatedDeliveryDate } } : {}),
      ...(orderDate ? { orderDate } : {}),
      buyer: { externalBuyerId: buyerUsername, ...(hasValidPhone ? { phone: normalizeVnPhone(shippingInfo.phone) } : {}) },
      ...(maskedRecipient
        ? {
            adminNoteOnCreate: `[Shopee] Đơn ${orderCode} — thông tin người nhận có thể bị Shopee ẩn bớt (tên/SĐT/địa chỉ). Vui lòng kiểm tra kỹ khi cần liên hệ hoặc giao hàng đặc biệt.`,
          }
        : {}),
    };
  }

  /** Matches every line item's product name against the catalog. Only an exact
   * (normalized) match auto-resolves — anything else makes the whole order group
   * NEEDS_REVIEW (Order.items[].productId is a required reference, so a partially
   * resolved order can't be saved). */
  private matchGroupItems(
    rows: ShopeeOrderRawRow[],
    productIndex: { id: string; name: string }[],
    productById: Map<string, ProductForMatching>,
  ): { items: ExternalOrderItemInput[]; issueItems: ShopeeOrderIssueItem[]; reasons: string[]; allMatched: boolean } {
    const items: ExternalOrderItemInput[] = [];
    const issueItems: ShopeeOrderIssueItem[] = [];
    const reasons: string[] = [];
    let allMatched = true;

    rows.forEach((row, idx) => {
      const rawName = row[SHOPEE_ORDER_COLUMNS.productName] || '';
      const quantity = Math.max(1, Math.round(parseVndAmount(row[SHOPEE_ORDER_COLUMNS.quantity])) || 1);
      const unitPrice = parseVndAmount(row[SHOPEE_ORDER_COLUMNS.offerPrice]);
      const variantLabel = row[SHOPEE_ORDER_COLUMNS.variantName]?.trim() || undefined;
      const matches = findBestProductMatches(rawName, productIndex);
      const top = matches[0];
      const matched = !!top && top.score >= AUTO_MATCH_SCORE;

      if (matched) {
        const product = productById.get(top.productId);
        if (!product) {
          allMatched = false;
          reasons.push(`Lỗi tra cứu sản phẩm cho dòng #${idx + 1}: "${rawName}"`);
          return;
        }
        const variant = matchVariantToColorOrSize(variantLabel || '', product.colors, product.sizes);
        const image =
          (variant.color && product.colors.find((c) => c.name === variant.color)?.images[0]) || product.images[0] || '';
        items.push({
          productId: product._id.toString(),
          productName: product.name,
          productImage: image,
          productSlug: product.slug,
          quantity,
          unitPrice,
          subtotal: unitPrice * quantity,
          ...(variant.color ? { color: variant.color } : {}),
          ...(variant.size ? { size: variant.size } : {}),
          ...(!variant.color && !variant.size && variantLabel ? { note: `Phân loại Shopee: ${variantLabel}` } : {}),
        });
        issueItems.push({
          productName: rawName,
          variantLabel,
          quantity,
          unitPrice,
          matched: true,
          matchedProductId: product._id,
          candidates: [],
        } as ShopeeOrderIssueItem);
      } else {
        allMatched = false;
        reasons.push(`Không tìm thấy sản phẩm khớp cho dòng #${idx + 1}: "${rawName}"`);
        issueItems.push({
          productName: rawName,
          variantLabel,
          quantity,
          unitPrice,
          matched: false,
          candidates: matches.map((m) => ({ productId: new Types.ObjectId(m.productId), name: m.name, score: m.score })),
        } as ShopeeOrderIssueItem);
      }
    });

    return { items, issueItems, reasons, allMatched };
  }

  private async resolveLingeringIssue(orderCode: string, orderId: Types.ObjectId, batchId: Types.ObjectId): Promise<void> {
    const issue = await this.issueModel.findOne({ orderCode, status: ShopeeOrderIssueStatus.OPEN }).exec();
    if (!issue) return;
    issue.status = ShopeeOrderIssueStatus.RESOLVED;
    issue.resolvedOrderId = orderId;
    issue.lastBatchId = batchId;
    await issue.save();
  }

  private async upsertIssue(
    orderCode: string,
    rows: ShopeeOrderRawRow[],
    items: ShopeeOrderIssueItem[],
    reasons: string[],
    batchId: Types.ObjectId,
    existing: ShopeeOrderSyncIssueDocument | null,
  ): Promise<ShopeeOrderSyncIssueDocument> {
    const now = new Date();
    const shippingInfoPreview = buildShippingPreviewFromGroup(rows);

    if (existing) {
      existing.rawRows = rows;
      existing.items = items;
      existing.reasons = reasons;
      existing.shippingInfoPreview = shippingInfoPreview;
      existing.status = ShopeeOrderIssueStatus.OPEN;
      existing.lastBatchId = batchId;
      existing.lastSeenAt = now;
      return existing.save();
    }

    return this.issueModel.create({
      orderCode,
      rawRows: rows,
      items,
      reasons,
      shippingInfoPreview,
      status: ShopeeOrderIssueStatus.OPEN,
      lastBatchId: batchId,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
}
