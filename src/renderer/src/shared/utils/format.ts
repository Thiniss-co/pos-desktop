import type { LocaleCode } from '@shared/contracts/preferences.contract'

export function formatNumber(
  value: number,
  locale: LocaleCode,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function formatCurrency(
  value: number,
  locale: LocaleCode,
  currency: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...options
  }).format(value)
}

export function formatDateTime(
  value: Date | string | number,
  locale: LocaleCode,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value))
}
