import type { LocaleCode } from '@shared/contracts/preferences.contract'

const MAXIMUM_INVOICE_TOTAL = 900_000_000_000_000
const MAXIMUM_RAW_INPUT_LENGTH = 32

export type MoneyFormatResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: 'MONEY_AMOUNT_INVALID' | 'MONEY_CURRENCY_UNSUPPORTED' }

export type MoneyInputResult =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false
      readonly code:
        | 'MONEY_INPUT_INVALID'
        | 'MONEY_INPUT_MULTILINE'
        | 'MONEY_INPUT_TOO_LONG'
        | 'MONEY_INPUT_OUT_OF_RANGE'
    }

const supportedCurrencies = new Set(['EGP', 'SAR', 'USD'])

const digitTranslations: Readonly<Record<string, string>> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٫': '.'
}

function normalizeDigits(value: string): string {
  return Array.from(value, (character) => digitTranslations[character] ?? character).join('')
}

function parseScaledInteger(rawValue: string, scale: number, maximum: number): MoneyInputResult {
  if (rawValue.length > MAXIMUM_RAW_INPUT_LENGTH) {
    return { ok: false, code: 'MONEY_INPUT_TOO_LONG' }
  }
  if (/\r|\n/.test(rawValue)) {
    return { ok: false, code: 'MONEY_INPUT_MULTILINE' }
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 3 || !Number.isSafeInteger(maximum)) {
    return { ok: false, code: 'MONEY_INPUT_INVALID' }
  }

  const normalized = normalizeDigits(rawValue.trim())
  const expression =
    scale === 0
      ? /^(?<whole>\d+)$/
      : new RegExp(`^(?<whole>\\d+)(?:\\.(?<fraction>\\d{1,${scale}}))?$`)
  const match = expression.exec(normalized)

  if (!match?.groups) {
    return { ok: false, code: 'MONEY_INPUT_INVALID' }
  }

  const divisor = 10 ** scale
  const whole = Number(match.groups.whole)
  const fraction = Number((match.groups.fraction ?? '').padEnd(scale, '0'))
  const value = whole * divisor + fraction

  if (!Number.isSafeInteger(value) || value > maximum) {
    return { ok: false, code: 'MONEY_INPUT_OUT_OF_RANGE' }
  }

  return { ok: true, value }
}

/** Parses a fixed discount without accepting grouping, internal whitespace, or floating-point input. */
export function parseMinorCurrencyInput(rawValue: string, exponent: number): MoneyInputResult {
  return parseScaledInteger(rawValue, exponent, MAXIMUM_INVOICE_TOTAL)
}

/** Parses a percentage discount into basis points, where `12.5` becomes `1250`. */
export function parsePercentageBasisPointsInput(rawValue: string): MoneyInputResult {
  return parseScaledInteger(rawValue, 2, 10_000)
}

/**
 * Formats integer minor units exactly. `Intl` receives only the whole-number BigInt; the
 * fractional digits are supplied from the original integer so floating-point conversion cannot
 * round a commercial amount.
 */
export function formatMinorCurrency(
  amount: number,
  locale: LocaleCode,
  currency: string,
  exponent: number
): MoneyFormatResult {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > MAXIMUM_INVOICE_TOTAL ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 3
  ) {
    return { ok: false, code: 'MONEY_AMOUNT_INVALID' }
  }
  if (!supportedCurrencies.has(currency)) {
    return { ok: false, code: 'MONEY_CURRENCY_UNSUPPORTED' }
  }

  const divisor = 10n ** BigInt(exponent)
  const value = BigInt(amount)
  const whole = value / divisor
  const fraction = exponent === 0 ? '' : String(value % divisor).padStart(exponent, '0')
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    numberingSystem: 'latn'
  }).formatToParts(whole)

  return {
    ok: true,
    value: parts.map((part) => (part.type === 'fraction' ? fraction : part.value)).join('')
  }
}
