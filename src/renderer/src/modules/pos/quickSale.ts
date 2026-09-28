/**
 * Pure helpers behind the POS quick-sale column: the scan-entry grammar and the quick cash tender
 * suggestions. No store, no bridge — the page wires these to the cart and payment stores.
 */

export type ScanEntryParseResult =
  | { readonly ok: true; readonly code: string; readonly quantityMilli: number | null }
  | { readonly ok: false; readonly code: 'SCAN_EMPTY' | 'SCAN_QUANTITY_INVALID' }

const MULTIPLIER_PATTERN = /^\s*(\d{1,6}(?:[.,]\d{1,3})?)\s*[*xX×]\s*(\S+)\s*$/
const QUANTITY_PATTERN = /^(\d{1,6})(?:[.,](\d{1,3}))?$/

/** Parses a quantity typed by the cashier (`2`, `1.5`, `0,250`) into thousandths. */
export function parseQuantityMilli(value: string): number | null {
  const match = QUANTITY_PATTERN.exec(value.trim())
  if (!match) {
    return null
  }

  const milli = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null
}

/**
 * The scan-entry field accepts a bare code (`6221234567890`) or a quantity prefix
 * (`3*6221234567890`, `1.5x6221234567890`). A null `quantityMilli` means "no explicit quantity":
 * the caller applies any pending multiplier, else one unit.
 */
export function parseScanEntry(raw: string): ScanEntryParseResult {
  const text = raw.trim()
  if (text.length === 0) {
    return { ok: false, code: 'SCAN_EMPTY' }
  }

  const multiplied = MULTIPLIER_PATTERN.exec(text)
  if (multiplied) {
    const quantityMilli = parseQuantityMilli(multiplied[1])
    return quantityMilli === null
      ? { ok: false, code: 'SCAN_QUANTITY_INVALID' }
      : { ok: true, code: multiplied[2], quantityMilli }
  }

  if (/\s/.test(text)) {
    return { ok: false, code: 'SCAN_EMPTY' }
  }

  return { ok: true, code: text, quantityMilli: null }
}

const CASH_STEPS = [1, 5, 10, 20, 50, 100, 200, 500, 1000] as const

/**
 * Suggested cash tenders for an outstanding amount, in minor units: the exact amount first, then
 * the next few "round" amounts a customer is likely to hand over (next 5, 10, 50, 100, …).
 * Always ascending, always distinct, always at least the amount due.
 */
export function quickCashAmounts(dueMinor: number, currencyExponent: number, limit = 4): number[] {
  if (!Number.isSafeInteger(dueMinor) || dueMinor <= 0 || currencyExponent < 0) {
    return []
  }

  const unit = 10 ** currencyExponent
  const amounts = new Set<number>([dueMinor])

  for (const step of CASH_STEPS) {
    const stepMinor = step * unit
    const rounded = Math.ceil(dueMinor / stepMinor) * stepMinor
    if (rounded > dueMinor && Number.isSafeInteger(rounded)) {
      amounts.add(rounded)
    }
  }

  return [...amounts].sort((a, b) => a - b).slice(0, limit)
}

/** Minor units → plain decimal text for the tender input (no grouping, no currency symbol). */
export function minorToDecimalText(amount: number, currencyExponent: number): string {
  if (currencyExponent === 0) {
    return String(amount)
  }

  const unit = 10 ** currencyExponent
  const whole = Math.trunc(amount / unit)
  const fraction = String(Math.abs(amount % unit)).padStart(currencyExponent, '0')
  return `${whole}.${fraction}`
}
