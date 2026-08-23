import { describe, expect, it } from 'vitest'
import { formatCurrency, formatNumber } from './format'

describe('presentation formatting', () => {
  it('formats values with the selected locale without changing the underlying arithmetic', () => {
    expect(formatNumber(1234.5, 'en')).toContain('1')
    expect(formatNumber(1234.5, 'ar')).toBe(new Intl.NumberFormat('ar').format(1234.5))
    expect(formatCurrency(42, 'en', 'USD')).toContain('42')
  })
})
