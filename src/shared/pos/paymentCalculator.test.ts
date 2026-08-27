import { describe, expect, it } from 'vitest'
import {
  calculatePayments,
  type PaymentInputRow,
  type ResolvedPaymentMethod
} from './paymentCalculator'

const CASH: ResolvedPaymentMethod = {
  uuid: 'cash-uuid',
  type: 'cash',
  isActive: true,
  requiresReference: false,
  allowsChange: true
}
const CARD: ResolvedPaymentMethod = {
  uuid: 'card-uuid',
  type: 'card',
  isActive: true,
  requiresReference: false,
  allowsChange: false
}
const CARD_REQUIRES_REFERENCE: ResolvedPaymentMethod = {
  uuid: 'card-ref-uuid',
  type: 'card',
  isActive: true,
  requiresReference: true,
  allowsChange: false
}
const INACTIVE_CASH: ResolvedPaymentMethod = {
  uuid: 'inactive-cash-uuid',
  type: 'cash',
  isActive: false,
  requiresReference: false,
  allowsChange: true
}

function row(overrides: Partial<PaymentInputRow> = {}): PaymentInputRow {
  return { id: 'row-1', methodUuid: CASH.uuid, amount: 1000, reference: null, ...overrides }
}

describe('calculatePayments', () => {
  it('accepts an exact cash tender', () => {
    expect(calculatePayments([row()], [CASH], 1000)).toEqual({
      ok: true,
      value: {
        rows: [{ id: 'row-1', methodUuid: CASH.uuid, type: 'cash', amount: 1000, reference: null }],
        paidTotalAmount: 1000,
        changeDueAmount: 0,
        dueAmount: 0
      }
    })
  })

  it('rejects zero rows', () => {
    expect(calculatePayments([], [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_ROWS_REQUIRED'
    })
  })

  it('rejects more than twenty rows', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row({ id: `row-${index}`, amount: 1 }))
    expect(calculatePayments(rows, [CASH], 21)).toEqual({ ok: false, code: 'PAYMENT_ROW_LIMIT' })
  })

  it('accepts exactly twenty rows', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row({ id: `row-${index}`, amount: 50 }))
    const result = calculatePayments(rows, [CASH], 1000)
    expect(result.ok).toBe(true)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a malformed amount %s',
    (amount) => {
      expect(calculatePayments([row({ amount })], [CASH], 1000)).toEqual({
        ok: false,
        code: 'PAYMENT_AMOUNT_INVALID'
      })
    }
  )

  it('rejects a single row over the maximum amount', () => {
    expect(calculatePayments([row({ amount: 900_000_000_000_001 })], [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_AMOUNT_LIMIT'
    })
  })

  it('rejects a zero-amount row on a non-zero sale', () => {
    expect(calculatePayments([row({ amount: 0 })], [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_AMOUNT_ZERO'
    })
  })

  it('rejects a zero-amount row when it is not the sole row, even on a zero-total sale', () => {
    const rows = [row({ id: 'row-1', amount: 0 }), row({ id: 'row-2', amount: 0 })]
    expect(calculatePayments(rows, [CASH], 0)).toEqual({ ok: false, code: 'PAYMENT_AMOUNT_ZERO' })
  })

  it('accepts a single zero-amount row on a zero-total sale', () => {
    expect(calculatePayments([row({ amount: 0 })], [CASH], 0)).toEqual({
      ok: true,
      value: {
        rows: [{ id: 'row-1', methodUuid: CASH.uuid, type: 'cash', amount: 0, reference: null }],
        paidTotalAmount: 0,
        changeDueAmount: 0,
        dueAmount: 0
      }
    })
  })

  it('rejects an unresolved method uuid', () => {
    expect(calculatePayments([row({ methodUuid: 'unknown-uuid' })], [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_METHOD_UNKNOWN'
    })
  })

  it('rejects a resolved but inactive method, distinctly from an absent one', () => {
    expect(
      calculatePayments([row({ methodUuid: INACTIVE_CASH.uuid })], [INACTIVE_CASH], 1000)
    ).toEqual({ ok: false, code: 'PAYMENT_METHOD_INACTIVE' })
  })

  it.each(['bank_transfer', 'wallet', 'loyalty'] as const)(
    'rejects a resolved, active %s method as unsupported',
    (type) => {
      const method: ResolvedPaymentMethod = {
        uuid: 'ineligible-uuid',
        type,
        isActive: true,
        requiresReference: false,
        allowsChange: false
      }
      expect(calculatePayments([row({ methodUuid: method.uuid })], [method], 1000)).toEqual({
        ok: false,
        code: 'PAYMENT_METHOD_TYPE_UNSUPPORTED'
      })
    }
  )

  it('rejects a null-typed resolved method as unsupported', () => {
    const method: ResolvedPaymentMethod = {
      uuid: 'null-type-uuid',
      type: null,
      isActive: true,
      requiresReference: false,
      allowsChange: false
    }
    expect(calculatePayments([row({ methodUuid: method.uuid })], [method], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_METHOD_TYPE_UNSUPPORTED'
    })
  })

  it('rejects a requires-reference method with no reference', () => {
    const rows = [row({ methodUuid: CARD_REQUIRES_REFERENCE.uuid, reference: null })]
    expect(calculatePayments(rows, [CARD_REQUIRES_REFERENCE], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_REFERENCE_REQUIRED'
    })
  })

  it('rejects a requires-reference method with an empty reference', () => {
    const rows = [row({ methodUuid: CARD_REQUIRES_REFERENCE.uuid, reference: '' })]
    expect(calculatePayments(rows, [CARD_REQUIRES_REFERENCE], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_REFERENCE_REQUIRED'
    })
  })

  it('rejects a requires-reference method with a reference over 255 characters', () => {
    const rows = [row({ methodUuid: CARD_REQUIRES_REFERENCE.uuid, reference: 'x'.repeat(256) })]
    expect(calculatePayments(rows, [CARD_REQUIRES_REFERENCE], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_REFERENCE_REQUIRED'
    })
  })

  it('accepts a requires-reference method with a valid reference', () => {
    const rows = [row({ methodUuid: CARD_REQUIRES_REFERENCE.uuid, reference: 'auth-123' })]
    const result = calculatePayments(rows, [CARD_REQUIRES_REFERENCE], 1000)
    expect(result.ok).toBe(true)
  })

  it('does not bound reference length for a method that does not require one', () => {
    const rows = [row({ reference: 'x'.repeat(500) })]
    const result = calculatePayments(rows, [CASH], 1000)
    expect(result.ok).toBe(true)
  })

  it('rejects a sum of otherwise-valid rows that crosses the aggregate limit', () => {
    const rows = [
      row({ id: 'row-1', amount: 500_000_000_000_000 }),
      row({ id: 'row-2', amount: 500_000_000_000_000 })
    ]
    expect(calculatePayments(rows, [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_TOTAL_LIMIT'
    })
  })

  it('rejects insufficient tender', () => {
    expect(calculatePayments([row({ amount: 600 })], [CASH], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_INSUFFICIENT_TENDER'
    })
  })

  it('accepts a cash overpayment and reports the change due', () => {
    expect(calculatePayments([row({ amount: 1500 })], [CASH], 1000)).toEqual({
      ok: true,
      value: {
        rows: [{ id: 'row-1', methodUuid: CASH.uuid, type: 'cash', amount: 1500, reference: null }],
        paidTotalAmount: 1500,
        changeDueAmount: 500,
        dueAmount: 0
      }
    })
  })

  it('rejects a non-cash-only overpayment (row 6)', () => {
    const rows = [row({ methodUuid: CARD.uuid, amount: 1200 })]
    expect(calculatePayments(rows, [CARD], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_NON_CASH_OVERPAYMENT'
    })
  })

  it('rejects a mixed cash+card overpayment even though the cash alone would cover it (row 5)', () => {
    const rows = [
      row({ id: 'row-1', amount: 800 }),
      row({ id: 'row-2', methodUuid: CARD.uuid, amount: 400 })
    ]
    expect(calculatePayments(rows, [CASH, CARD], 1000)).toEqual({
      ok: false,
      code: 'PAYMENT_NON_CASH_OVERPAYMENT'
    })
  })

  it('accepts an exact split cash+card tender', () => {
    const rows = [
      row({ id: 'row-1', amount: 600 }),
      row({ id: 'row-2', methodUuid: CARD.uuid, amount: 400 })
    ]
    const result = calculatePayments(rows, [CASH, CARD], 1000)
    expect(result).toEqual({
      ok: true,
      value: {
        rows: [
          { id: 'row-1', methodUuid: CASH.uuid, type: 'cash', amount: 600, reference: null },
          { id: 'row-2', methodUuid: CARD.uuid, type: 'card', amount: 400, reference: null }
        ],
        paidTotalAmount: 1000,
        changeDueAmount: 0,
        dueAmount: 0
      }
    })
  })

  it('keeps duplicate cash rows separate rather than aggregating them', () => {
    const rows = [row({ id: 'row-1', amount: 500 }), row({ id: 'row-2', amount: 500 })]
    const result = calculatePayments(rows, [CASH], 1000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.rows).toHaveLength(2)
    }
  })
})
