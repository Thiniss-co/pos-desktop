import type { PaymentMethodType } from '@shared/contracts/catalog.contract'

const MAX_TOTAL = 900_000_000_000_000n
const MAX_TOTAL_NUMBER = 900_000_000_000_000
const MAX_ROWS = 20
const MAX_REFERENCE_LENGTH = 255

export type SupportedPaymentMethodType = 'cash' | 'card' | 'other'

export type PaymentErrorCode =
  | 'PAYMENT_ROWS_REQUIRED'
  | 'PAYMENT_ROW_LIMIT'
  | 'PAYMENT_AMOUNT_INVALID'
  | 'PAYMENT_AMOUNT_ZERO'
  | 'PAYMENT_AMOUNT_LIMIT'
  | 'PAYMENT_METHOD_UNKNOWN'
  | 'PAYMENT_METHOD_INACTIVE'
  | 'PAYMENT_METHOD_TYPE_UNSUPPORTED'
  | 'PAYMENT_REFERENCE_REQUIRED'
  | 'PAYMENT_INSUFFICIENT_TENDER'
  | 'PAYMENT_NON_CASH_OVERPAYMENT'
  | 'PAYMENT_TOTAL_LIMIT'

export type PaymentCalculationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: PaymentErrorCode }

export interface PaymentInputRow {
  readonly id: string
  readonly methodUuid: string
  readonly amount: number
  readonly reference: string | null
}

/** What CP-2's `resolveForCheckout` returns per method — never the renderer's claim about it. */
export interface ResolvedPaymentMethod {
  readonly uuid: string
  readonly type: PaymentMethodType | null
  readonly isActive: boolean
  readonly requiresReference: boolean
  readonly allowsChange: boolean
}

export interface PaymentCalculationRow {
  readonly id: string
  readonly methodUuid: string
  readonly type: SupportedPaymentMethodType
  readonly amount: number
  readonly reference: string | null
}

export interface PaymentCalculation {
  readonly rows: readonly PaymentCalculationRow[]
  readonly paidTotalAmount: number
  readonly changeDueAmount: number
  readonly dueAmount: number
}

function success<T>(value: T): PaymentCalculationResult<T> {
  return { ok: true, value }
}

function failure<T = never>(code: PaymentErrorCode): PaymentCalculationResult<T> {
  return { ok: false, code }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSupportedType(type: PaymentMethodType | null): type is SupportedPaymentMethodType {
  return type === 'cash' || type === 'card' || type === 'other'
}

/**
 * Pure Phase 3E payment arithmetic: tendered/applied amount, change due, and the due balance.
 * Reuses `calculateCart`'s `grandTotalAmount` verbatim — never re-derives a subtotal, discount,
 * allocation, or tax figure. No Vue, Pinia, Electron, Node, storage, or transport dependency, and
 * never throws for invalid user or catalog input.
 *
 * Rules run in this order so the first failure is always the reported one; rows are checked in
 * array order, and every rule for a row is checked before the next row is examined.
 */
export function calculatePayments(
  rows: readonly PaymentInputRow[],
  methods: readonly ResolvedPaymentMethod[],
  grandTotalAmount: number
): PaymentCalculationResult<PaymentCalculation> {
  if (rows.length === 0) {
    return failure('PAYMENT_ROWS_REQUIRED')
  }

  if (rows.length > MAX_ROWS) {
    return failure('PAYMENT_ROW_LIMIT')
  }

  const resolvedRows: PaymentCalculationRow[] = []

  for (const row of rows) {
    if (!isSafeNonNegativeInteger(row.amount)) {
      return failure('PAYMENT_AMOUNT_INVALID')
    }

    if (row.amount > MAX_TOTAL_NUMBER) {
      return failure('PAYMENT_AMOUNT_LIMIT')
    }

    if (row.amount === 0 && !(rows.length === 1 && grandTotalAmount === 0)) {
      return failure('PAYMENT_AMOUNT_ZERO')
    }

    const method = methods.find((candidate) => candidate.uuid === row.methodUuid)
    if (!method) {
      return failure('PAYMENT_METHOD_UNKNOWN')
    }

    if (!method.isActive) {
      return failure('PAYMENT_METHOD_INACTIVE')
    }

    if (!isSupportedType(method.type)) {
      return failure('PAYMENT_METHOD_TYPE_UNSUPPORTED')
    }

    if (method.requiresReference) {
      const reference = row.reference
      if (reference === null || reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) {
        return failure('PAYMENT_REFERENCE_REQUIRED')
      }
    }

    resolvedRows.push({
      id: row.id,
      methodUuid: row.methodUuid,
      type: method.type,
      amount: row.amount,
      reference: row.reference
    })
  }

  const grandTotal = BigInt(grandTotalAmount)
  const paidTotal = resolvedRows.reduce((sum, row) => sum + BigInt(row.amount), 0n)

  if (paidTotal > MAX_TOTAL) {
    return failure('PAYMENT_TOTAL_LIMIT')
  }

  const cashPaid = resolvedRows.reduce(
    (sum, row) => (row.type === 'cash' ? sum + BigInt(row.amount) : sum),
    0n
  )
  const overpayment = paidTotal > grandTotal ? paidTotal - grandTotal : 0n
  const changeDue = overpayment < cashPaid ? overpayment : cashPaid
  const due = grandTotal > paidTotal ? grandTotal - paidTotal : 0n

  if (due > 0n) {
    return failure('PAYMENT_INSUFFICIENT_TENDER')
  }

  if (overpayment > 0n && resolvedRows.some((row) => row.type !== 'cash')) {
    return failure('PAYMENT_NON_CASH_OVERPAYMENT')
  }

  return success({
    rows: resolvedRows,
    paidTotalAmount: Number(paidTotal),
    changeDueAmount: Number(changeDue),
    dueAmount: Number(due)
  })
}
