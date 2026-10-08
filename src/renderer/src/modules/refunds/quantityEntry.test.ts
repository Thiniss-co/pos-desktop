import { describe, expect, it } from 'vitest'
import { parseRefundQuantityEntry } from './quantityEntry'

describe('refund quantity entry', () => {
  it('accepts a fractional quantity up to the refundable quantity, in milli-units', () => {
    expect(parseRefundQuantityEntry('0.5', 1250)).toEqual({ ok: true, milli: 500 })
    expect(parseRefundQuantityEntry('1.25', 1250)).toEqual({ ok: true, milli: 1250 })
    expect(parseRefundQuantityEntry('0.001', 1250)).toEqual({ ok: true, milli: 1 })
    expect(parseRefundQuantityEntry(' 2 ', 3000)).toEqual({ ok: true, milli: 2000 })
  })

  it('refuses more than the refundable quantity', () => {
    expect(parseRefundQuantityEntry('1.251', 1250)).toEqual({
      ok: false,
      reason: 'over_refundable'
    })
    expect(parseRefundQuantityEntry('0.8', 750)).toEqual({ ok: false, reason: 'over_refundable' })
  })

  it('refuses zero, a fourth decimal, a sign or anything that is not a quantity', () => {
    for (const draft of ['', '0', '0.000', '0.0005', '1.2345', '-1', '1,5', '.5', '1.', 'abc']) {
      expect(parseRefundQuantityEntry(draft, 5000)).toEqual({ ok: false, reason: 'invalid' })
    }
  })
})
