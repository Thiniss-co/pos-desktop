import { describe, expect, it } from 'vitest'
import { calculateRefund, calculateRefundLine, refundQuantityToMilli } from './refundCalculator'
import type { RefundR4LineInput } from '@shared/contracts/refund.contract'

/**
 * Golden parity with `pos-backend/tests/Unit/PosRefundCalculatorConservationTest.php` (plan §1
 * worked tables). Every expected number is a literal, transcribed from the PHP test's own
 * independently-derived numbers -- not produced by calling `calculateRefund` and echoing it back.
 */

function baseLine(overrides: Partial<RefundR4LineInput>): RefundR4LineInput {
  return {
    invoiceItemRemoteUuid: '11111111-1111-4111-8111-111111111111',
    productUuid: '22222222-2222-4222-8222-222222222222',
    productName: 'Product',
    taxMode: 'exclusive',
    originalQuantityMilli: 3000,
    originalSubtotalAmount: 0,
    originalDiscountAmount: 0,
    originalTaxAmount: 0,
    originalTotalAmount: 0,
    priorRefundedQuantityMilli: 0,
    priorSubtotalAmount: 0,
    priorDiscountAmount: 0,
    priorTaxAmount: 0,
    priorTotalAmount: 0,
    requestedQuantityMilli: 1000,
    feasibility: { tier: 'ok', reasons: [] },
    ...overrides
  }
}

function sequence(
  base: Omit<
    RefundR4LineInput,
    | 'requestedQuantityMilli'
    | 'priorRefundedQuantityMilli'
    | 'priorSubtotalAmount'
    | 'priorDiscountAmount'
    | 'priorTaxAmount'
    | 'priorTotalAmount'
  >,
  quantities: readonly number[]
): { steps: Array<[number, number, number, number]>; sums: [number, number, number, number] } {
  let prior = { quantity: 0, subtotal: 0, discount: 0, tax: 0, total: 0 }
  const steps: Array<[number, number, number, number]> = []

  for (const quantity of quantities) {
    const result = calculateRefundLine({
      ...base,
      requestedQuantityMilli: quantity,
      priorRefundedQuantityMilli: prior.quantity,
      priorSubtotalAmount: prior.subtotal,
      priorDiscountAmount: prior.discount,
      priorTaxAmount: prior.tax,
      priorTotalAmount: prior.total
    })
    steps.push([result.subtotalAmount, result.discountAmount, result.taxAmount, result.totalAmount])
    prior = {
      quantity: prior.quantity + quantity,
      subtotal: prior.subtotal + result.subtotalAmount,
      discount: prior.discount + result.discountAmount,
      tax: prior.tax + result.taxAmount,
      total: prior.total + result.totalAmount
    }
  }

  return { steps, sums: [prior.subtotal, prior.discount, prior.tax, prior.total] }
}

describe('R4 refund calculator — golden parity with the backend', () => {
  it('(a) 100 over quantity 3 refunded 1+1+1 conserves', () => {
    const base = baseLine({ originalTotalAmount: 100, originalSubtotalAmount: 100 })
    const { steps, sums } = sequence(base, [1000, 1000, 1000])

    expect(steps).toEqual([
      [33, 0, 0, 33],
      [34, 0, 0, 34],
      [33, 0, 0, 33]
    ])
    expect(sums).toEqual([100, 0, 0, 100])
  })

  it('(b) subtotal 100 tax 1 total 101 stays balanced at every step', () => {
    const base = baseLine({
      originalSubtotalAmount: 100,
      originalTaxAmount: 1,
      originalTotalAmount: 101
    })
    const { steps, sums } = sequence(base, [1000, 1000, 1000])

    expect(steps).toEqual([
      [34, 0, 0, 34],
      [32, 0, 1, 33],
      [34, 0, 0, 34]
    ])
    expect(sums).toEqual([100, 0, 1, 101])

    for (const [sub, disc, tax, total] of steps) {
      expect(sub - disc + tax).toBe(total)
    }
  })

  it('(c) tax 95 across three equal portions reverses exactly 95', () => {
    const base = baseLine({
      originalSubtotalAmount: 1000,
      originalTaxAmount: 95,
      originalTotalAmount: 1095
    })
    const { steps, sums } = sequence(base, [1000, 1000, 1000])

    expect(steps).toEqual([
      [333, 0, 32, 365],
      [334, 0, 31, 365],
      [333, 0, 32, 365]
    ])
    expect(sums[2]).toBe(95)
  })

  it('(d) discount and fractional quantities conserve', () => {
    const base = baseLine({
      originalQuantityMilli: 1500,
      originalSubtotalAmount: 1000,
      originalDiscountAmount: 333,
      originalTaxAmount: 95,
      originalTotalAmount: 762
    })
    const { steps, sums } = sequence(base, [500, 500, 500])

    expect(steps).toEqual([
      [333, 111, 32, 254],
      [334, 111, 31, 254],
      [333, 111, 32, 254]
    ])
    expect(sums).toEqual([1000, 333, 95, 762])
  })

  it('(g) inclusive tax is carved out of the total, never added', () => {
    const base = baseLine({
      taxMode: 'inclusive',
      originalSubtotalAmount: 1000,
      originalTaxAmount: 95,
      originalTotalAmount: 1000
    })
    const { steps, sums } = sequence(base, [1000, 1000, 1000])

    expect(steps).toEqual([
      [333, 0, 32, 333],
      [334, 0, 31, 334],
      [333, 0, 32, 333]
    ])
    expect(sums).toEqual([1000, 0, 95, 1000])
  })

  it('(e) legacy 33+33 history is absorbed and lands exactly on 100', () => {
    const result = calculateRefundLine(
      baseLine({
        originalTotalAmount: 100,
        originalSubtotalAmount: 100,
        priorRefundedQuantityMilli: 2000,
        priorTotalAmount: 66,
        requestedQuantityMilli: 1000
      })
    )
    expect(result.totalAmount).toBe(34)
    expect(66 + result.totalAmount).toBe(100)
  })

  it('tax is never reversed beyond money the refund actually returns (G2)', () => {
    const result = calculateRefundLine(
      baseLine({
        originalQuantityMilli: 4000,
        originalSubtotalAmount: 1,
        originalTaxAmount: 1,
        originalTotalAmount: 2,
        priorRefundedQuantityMilli: 2000,
        priorTotalAmount: 2,
        requestedQuantityMilli: 2000
      })
    )
    expect(result.totalAmount).toBe(0)
    expect(result.taxAmount).toBe(0)
  })

  it('calculateRefund sums multiple lines exactly', () => {
    const lineA = baseLine({
      originalTotalAmount: 500,
      originalSubtotalAmount: 500,
      requestedQuantityMilli: 1000
    })
    const lineB = baseLine({
      invoiceItemRemoteUuid: '33333333-3333-4333-8333-333333333333',
      originalTotalAmount: 300,
      originalSubtotalAmount: 300,
      requestedQuantityMilli: 3000,
      originalQuantityMilli: 3000
    })
    const result = calculateRefund([lineA, lineB])
    // lineA: 500/3 of a 3-qty line refunded 1 unit -> 167. lineB: full 300.
    expect(result.lines[0].totalAmount).toBe(167)
    expect(result.lines[1].totalAmount).toBe(300)
    expect(result.grandTotalAmount).toBe(467)
    expect(result.subtotalAmount).toBe(467)
  })

  it('refundQuantityToMilli parses fractional quantities', () => {
    expect(refundQuantityToMilli('1.500')).toBe(1500)
    expect(refundQuantityToMilli('2')).toBe(2000)
    expect(refundQuantityToMilli('0.005')).toBe(5)
  })
})
