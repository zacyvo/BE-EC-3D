import { PipelineStage } from 'mongoose';
import { RETURN_SETTLED_STATUSES } from './schemas/order.schema';

/** True when the order's return request is settled (goods back with the shop, refund decided). */
const isReturnSettled = {
  $in: [{ $ifNull: ['$returnRequest.status', null] }, RETURN_SETTLED_STATUSES],
};

/** `$total` minus the VAT collected for an e-invoice (owed to the tax office, not revenue) and
 * minus the goods refund of a settled return — use instead of `'$total'` wherever revenue is
 * summed from orders. */
export const NET_ORDER_TOTAL_EXPR = {
  $subtract: [
    { $subtract: ['$total', { $ifNull: ['$vatAmount', 0] }] },
    { $cond: [isReturnSettled, { $ifNull: ['$returnRequest.refundAmount', 0] }, 0] },
  ],
};

/** Drop-in replacement for `{ $unwind: '$items' }` that also sets `_returnedQty` — how many
 * units of this line came back through a settled return (0 otherwise). Return items point at
 * their line by index (`returnRequest.items[].itemIndex`). */
export const UNWIND_ITEMS_WITH_RETURNS: PipelineStage[] = [
  { $unwind: { path: '$items', includeArrayIndex: '_itemIdx' } },
  {
    $addFields: {
      _returnedQty: {
        $cond: [
          isReturnSettled,
          {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: { $ifNull: ['$returnRequest.items', []] },
                    as: 'r',
                    cond: { $eq: ['$$r.itemIndex', '$_itemIdx'] },
                  },
                },
                as: 'r',
                in: '$$r.quantity',
              },
            },
          },
          0,
        ],
      },
    },
  },
];

/** Units actually kept by the customer for the current unwound line. */
export const NET_ITEM_QTY_EXPR = { $subtract: ['$items.quantity', '$_returnedQty'] };
