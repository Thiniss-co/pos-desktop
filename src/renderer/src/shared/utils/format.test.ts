import { describe, expect, it } from 'vitest'
import { formatCurrency, formatNumber } from './format'

describe('presentation formatting', () => {
  it('formats values with the selected locale without changing the underlying arithmetic', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5')
    expect(formatCurrency(42, 'en', 'USD')).toBe('$42.00')
  })

  it('renders Latin digits for Arabic locale by default, matching receipts and printers', () => {
    // Intl.NumberFormat('ar') defaults to Arabic-Indic digits (١٢٣٤) unless told otherwise; POS
    // money and quantities must stay in Latin digits regardless of the active UI language.
    expect(formatNumber(1234.5, 'ar')).toBe('1,234.5')
    expect(formatCurrency(42, 'ar', 'USD')).not.toMatch(/[٠-٩]/)
  })

  it('lets a caller opt into a different numbering system explicitly', () => {
    expect(formatNumber(123, 'ar', { numberingSystem: 'arab' })).toMatch(/[٠-٩]/)
  })
})
