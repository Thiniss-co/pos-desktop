import { describe, expect, it } from 'vitest'
import {
  formatMinorCurrency,
  parseMinorCurrencyInput,
  parsePercentageBasisPointsInput
} from './minorUnits'

function expectedCurrencyParts(
  amount: number,
  locale: 'en' | 'ar',
  currency: string,
  exponent: number
): string {
  const scale = 10n ** BigInt(exponent)
  const value = BigInt(amount)
  const fraction = exponent === 0 ? '' : String(value % scale).padStart(exponent, '0')

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    numberingSystem: 'latn'
  })
    .formatToParts(value / scale)
    .map((part) => (part.type === 'fraction' ? fraction : part.value))
    .join('')
}

describe('formatMinorCurrency', () => {
  it('preserves exact integer parts at zero, large boundaries, and every supported exponent', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const currency of ['EGP', 'SAR', 'USD']) {
        for (const exponent of [0, 2, 3]) {
          for (const amount of [0, 1234, 2_147_483_647, 2_147_483_648, 900_000_000_000_000]) {
            const result = formatMinorCurrency(amount, locale, currency, exponent)
            expect(result).toEqual({
              ok: true,
              value: expectedCurrencyParts(amount, locale, currency, exponent)
            })
          }
        }
      }
    }
  })

  it('uses Latin digits for Arabic POS presentation', () => {
    const result = formatMinorCurrency(1234, 'ar', 'SAR', 3)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.value).not.toMatch(/[٠-٩]/)
    }
  })

  it('rejects unsafe values and currencies outside the declared desktop domain', () => {
    expect(formatMinorCurrency(Number.MAX_SAFE_INTEGER + 1, 'en', 'EGP', 2)).toEqual({
      ok: false,
      code: 'MONEY_AMOUNT_INVALID'
    })
    expect(formatMinorCurrency(1, 'en', 'EUR', 2)).toEqual({
      ok: false,
      code: 'MONEY_CURRENCY_UNSUPPORTED'
    })
    expect(formatMinorCurrency(900_000_000_000_001, 'en', 'EGP', 2)).toEqual({
      ok: false,
      code: 'MONEY_AMOUNT_INVALID'
    })
  })

  it('parses fixed and percentage discounts exactly without reinterpreting separators', () => {
    expect(parseMinorCurrencyInput(' ١٢٫٥ ', 2)).toEqual({ ok: true, value: 1250 })
    expect(parsePercentageBasisPointsInput('12.5')).toEqual({ ok: true, value: 1250 })
    expect(parseMinorCurrencyInput('42', 0)).toEqual({ ok: true, value: 42 })
    expect(parseMinorCurrencyInput('1,000', 2)).toEqual({
      ok: false,
      code: 'MONEY_INPUT_INVALID'
    })
    expect(parseMinorCurrencyInput('1 000', 2)).toEqual({
      ok: false,
      code: 'MONEY_INPUT_INVALID'
    })
    expect(parseMinorCurrencyInput('1\n2', 2)).toEqual({
      ok: false,
      code: 'MONEY_INPUT_MULTILINE'
    })
  })
})
