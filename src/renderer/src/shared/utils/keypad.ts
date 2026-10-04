/**
 * POS improvements, Stage 5 — the on-screen numeric keypad's editing rule, kept pure so every key
 * sequence is testable without a DOM.
 *
 * The keypad edits the same string a hardware keyboard would type into the field; it never parses
 * or formats money. `maxDecimals` caps the digits after the separator (0 forbids a separator).
 */
export type KeypadKey =
  '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back' | 'clear'

export const KEYPAD_DIGITS: readonly KeypadKey[] = ['7', '8', '9', '4', '5', '6', '1', '2', '3']

export function applyKeypadKey(value: string, key: KeypadKey, maxDecimals: number): string {
  if (key === 'clear') {
    return ''
  }
  if (key === 'back') {
    return value.slice(0, -1)
  }
  const separator = value.indexOf('.')
  if (key === '.') {
    if (maxDecimals <= 0 || separator !== -1) {
      return value
    }
    return value === '' ? '0.' : `${value}.`
  }
  if (separator !== -1 && value.length - separator - 1 >= maxDecimals) {
    return value
  }
  // A leading zero is replaced, never repeated ("0" then "5" reads "5", not "05").
  if (value === '0') {
    return key
  }
  return `${value}${key}`
}
