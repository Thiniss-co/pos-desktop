import type { LocaleCode } from '@shared/contracts/preferences.contract'

// Money and quantities must render with a consistent digit system across locales — receipts,
// keyboards, barcode scanners, and printers in this market all expect Latin digits, and
// Intl.NumberFormat('ar') defaults to Arabic-Indic digits (١٢٣) otherwise. Callers can still
// request a different numbering system explicitly via `options.numberingSystem`.
function withDefaultNumberingSystem(options: Intl.NumberFormatOptions): Intl.NumberFormatOptions {
  return { numberingSystem: 'latn', ...options }
}

export function formatNumber(
  value: number,
  locale: LocaleCode,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, withDefaultNumberingSystem(options)).format(value)
}

export function formatCurrency(
  value: number,
  locale: LocaleCode,
  currency: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(
    locale,
    withDefaultNumberingSystem({ style: 'currency', currency, ...options })
  ).format(value)
}

export function formatDateTime(
  value: Date | string | number,
  locale: LocaleCode,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value))
}
