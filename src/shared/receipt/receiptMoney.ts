import { formatMinorCurrency } from '@shared/money/minorUnits'
import type { LocaleCode } from '@shared/contracts/preferences.contract'

/**
 * Receipt-printing plan — money formatting for the printed page. Reuses the existing
 * `formatMinorCurrency` (EGP/SAR/USD) and falls back to a plain, honest decimal rendering for any
 * other currency rather than failing to print. Never recalculates an amount; only formats what was
 * already stored.
 */

function receiptLocale(locale: 'en' | 'ar'): LocaleCode {
  return locale
}

export function formatReceiptDecimal(amount: number, currency: string, exponent: number): string {
  const divisor = 10 ** exponent
  const whole = Math.trunc(amount / divisor)
  const fraction = exponent === 0 ? '' : String(amount % divisor).padStart(exponent, '0')
  const wholeText = whole.toLocaleString('en-US')
  return exponent === 0 ? `${wholeText} ${currency}` : `${wholeText}.${fraction} ${currency}`
}

export function formatReceiptMoney(
  amount: number,
  locale: 'en' | 'ar',
  currency: string,
  exponent: number
): string {
  if (amount < 0) {
    return `−${formatReceiptMoney(-amount, locale, currency, exponent)}`
  }

  const result = formatMinorCurrency(amount, receiptLocale(locale), currency, exponent)
  return result.ok ? result.value : formatReceiptDecimal(amount, currency, exponent)
}
