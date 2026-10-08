import { refundQuantityToMilli } from '@shared/pos/refundCalculator'

/**
 * A refund quantity typed (or keyed) by the cashier, checked before it becomes a selection. The
 * grammar is the catalog's quantity scale (up to three decimals, like a cart quantity); the limit is
 * the backend's refundable quantity for the line. Main recalculates and refuses an over-refund too.
 */
export type RefundQuantityEntry =
  | { readonly ok: true; readonly milli: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'over_refundable' }

export function parseRefundQuantityEntry(
  draft: string,
  maxRefundableMilli: number
): RefundQuantityEntry {
  const value = draft.trim()

  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    return { ok: false, reason: 'invalid' }
  }

  const milli = refundQuantityToMilli(value)

  if (!Number.isSafeInteger(milli) || milli <= 0) {
    return { ok: false, reason: 'invalid' }
  }

  if (milli > maxRefundableMilli) {
    return { ok: false, reason: 'over_refundable' }
  }

  return { ok: true, milli }
}
