import type {
  RefundR4LineInput,
  RefundR4LineResult,
  RefundR4Result
} from '@shared/contracts/refund.contract'

/**
 * R4 — anchor-total refund proration (plan §1, decision D1).
 *
 * A direct mirror of `pos-backend/app/Modules/POS/Services/PosRefundCalculator.php`, so preview
 * shown to the cashier and the backend's authoritative recomputation land on the same numbers.
 * Golden-tested against the same literal tables as the backend's
 * `tests/Unit/PosRefundCalculatorConservationTest.php`.
 *
 * ## Why `total` is the anchor and `subtotal` is derived
 *
 * The previous rule prorated every component independently and did not conserve: a line totalling
 * 100 over quantity 3, refunded one unit at a time, returned 33+33+33 = 99, and its tax of 95
 * returned 32+32+32 = 96 -- more tax reversed than was ever charged. `total` is what the customer
 * receives, what `Σ payments` must equal, and what the accounting journal posts, so it anchors the
 * rule; `subtotal` is derived so the tax-mode identity holds by construction in both modes.
 *
 * ## Feasibility is decided upstream
 *
 * This function assumes every line is `ok` tier (plan §1's feasibility gate). It does not check
 * `feasibility` itself -- `RefundPreviewService`/main refuses `soft`/`hard` lines before calling it
 * (decision D2), and never silently drops a selected line.
 */

function toMilli(quantity: string): number {
  const [whole, fraction = ''] = quantity.split('.')
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3))
}

function prorate(amount: number, numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.floor((amount * numerator + Math.floor(denominator / 2)) / denominator)
}

export function calculateRefundLine(input: RefundR4LineInput): RefundR4LineResult {
  const cumulativeMilli = input.priorRefundedQuantityMilli + input.requestedQuantityMilli

  if (input.requestedQuantityMilli <= 0 || cumulativeMilli > input.originalQuantityMilli) {
    throw new Error(
      'Refund quantity must be greater than zero and cannot exceed the original invoice item quantity.'
    )
  }

  const entitledTotal = prorate(
    input.originalTotalAmount,
    cumulativeMilli,
    input.originalQuantityMilli
  )
  const lineTotal = Math.max(0, entitledTotal - input.priorTotalAmount)

  const entitledTax = prorate(input.originalTaxAmount, cumulativeMilli, input.originalQuantityMilli)
  const lineTax = Math.max(0, Math.min(entitledTax - input.priorTaxAmount, lineTotal))

  const entitledDiscount = prorate(
    input.originalDiscountAmount,
    cumulativeMilli,
    input.originalQuantityMilli
  )
  const lineDiscount = Math.max(0, entitledDiscount - input.priorDiscountAmount)

  const lineTaxable = lineTotal - (input.taxMode === 'exclusive' ? lineTax : 0)
  const lineSubtotal = lineTaxable + lineDiscount

  return {
    invoiceItemRemoteUuid: input.invoiceItemRemoteUuid,
    subtotalAmount: lineSubtotal,
    discountAmount: lineDiscount,
    taxAmount: lineTax,
    totalAmount: lineTotal
  }
}

export function calculateRefund(lines: readonly RefundR4LineInput[]): RefundR4Result {
  if (lines.length === 0) {
    throw new Error('At least one refund line is required.')
  }

  const results = lines.map((line) => calculateRefundLine(line))

  return {
    lines: results,
    subtotalAmount: results.reduce((sum, r) => sum + r.subtotalAmount, 0),
    discountTotalAmount: results.reduce((sum, r) => sum + r.discountAmount, 0),
    taxTotalAmount: results.reduce((sum, r) => sum + r.taxAmount, 0),
    grandTotalAmount: results.reduce((sum, r) => sum + r.totalAmount, 0)
  }
}

export { toMilli as refundQuantityToMilli }
