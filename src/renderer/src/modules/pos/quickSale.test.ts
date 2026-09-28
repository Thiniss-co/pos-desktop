import { describe, expect, it } from 'vitest'
import {
  minorToDecimalText,
  parseQuantityMilli,
  parseScanEntry,
  quickCashAmounts
} from './quickSale'

describe('parseScanEntry', () => {
  it('accepts a bare code with no explicit quantity', () => {
    expect(parseScanEntry(' 6221234567890 ')).toEqual({
      ok: true,
      code: '6221234567890',
      quantityMilli: null
    })
  })

  it('accepts a quantity prefix with *, x, or ×', () => {
    expect(parseScanEntry('3*6221234567890')).toEqual({
      ok: true,
      code: '6221234567890',
      quantityMilli: 3000
    })
    expect(parseScanEntry('1.5x SKU-1')).toEqual({ ok: true, code: 'SKU-1', quantityMilli: 1500 })
    expect(parseScanEntry('0,250×123')).toEqual({ ok: true, code: '123', quantityMilli: 250 })
  })

  it('rejects empty input and a zero quantity', () => {
    expect(parseScanEntry('   ')).toEqual({ ok: false, code: 'SCAN_EMPTY' })
    expect(parseScanEntry('0*123')).toEqual({ ok: false, code: 'SCAN_QUANTITY_INVALID' })
  })
})

describe('parseQuantityMilli', () => {
  it('parses up to three decimals and refuses anything else', () => {
    expect(parseQuantityMilli('2')).toBe(2000)
    expect(parseQuantityMilli('0.125')).toBe(125)
    expect(parseQuantityMilli('1.2345')).toBeNull()
    expect(parseQuantityMilli('-1')).toBeNull()
    expect(parseQuantityMilli('0')).toBeNull()
  })
})

describe('quickCashAmounts', () => {
  it('offers the exact amount first, then distinct round-ups', () => {
    // 37.40 with two decimals → exact, 38, 40, 50
    expect(quickCashAmounts(3740, 2)).toEqual([3740, 3800, 4000, 5000])
  })

  it('does not duplicate an already round amount', () => {
    expect(quickCashAmounts(5000, 2)).toEqual([5000, 6000, 10000, 20000])
  })

  it('returns nothing when nothing is due', () => {
    expect(quickCashAmounts(0, 2)).toEqual([])
    expect(quickCashAmounts(-5, 2)).toEqual([])
  })
})

describe('minorToDecimalText', () => {
  it('formats without grouping or currency', () => {
    expect(minorToDecimalText(123456, 2)).toBe('1234.56')
    expect(minorToDecimalText(5, 2)).toBe('0.05')
    expect(minorToDecimalText(12, 0)).toBe('12')
    expect(minorToDecimalText(1005, 3)).toBe('1.005')
  })
})
