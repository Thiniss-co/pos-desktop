/**
 * POS improvements, Stage 6 — the ZATCA Phase 1 (simplified e-invoice) QR payload.
 *
 * ZATCA's QR code guide: five TLV fields — 1 seller name, 2 VAT registration number, 3 time stamp,
 * 4 invoice (or credit/debit note) total with VAT, 5 VAT total — each a one-byte tag, a one-byte length
 * (the value's UTF-8 BYTE length) and the value, concatenated and Base64-encoded; at most 500 Base64
 * characters. Official vector: "Bobs Records" / 310122393500003 / 2022-04-25T15:30:00Z / 1000.00 /
 * 150.00 → `AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==`.
 *
 * The PHP twin is `App\Modules\POS\Support\ZatcaPhase1Qr`; both are pinned by
 * `tests/fixtures/zatca-phase1-qr-golden.json` (byte parity, `verify:fixture`).
 *
 * A credit note carries its own time stamp and totals as POSITIVE amounts — an interpretation of the
 * official texts (which do not state the sign), reported as unverified.
 */

export const ZATCA_QR_MAX_BASE64_LENGTH = 500
export const ZATCA_QR_MAX_VALUE_BYTES = 255

export interface ZatcaQrFacts {
  readonly sellerName: string
  readonly vatNumber: string
  /** UTC `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly timestamp: string
  readonly totalMinor: number
  readonly vatMinor: number
  readonly currencyExponent: number
}

export interface ZatcaQrFields {
  readonly sellerName: string
  readonly vatNumber: string
  readonly timestamp: string
  readonly total: string
  readonly vatTotal: string
}

export type ZatcaQrResult =
  { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly reason: string }

const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const AMOUNT = /^\d+(\.\d+)?$/

/** An amount in minor units as the invariant decimal the QR carries ("1000.00"). */
export function zatcaAmount(minor: number, exponent: number): string {
  if (
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 3
  ) {
    throw new RangeError('Amounts are non-negative minor units with an exponent of 0–3')
  }
  if (exponent === 0) {
    return String(minor)
  }
  const digits = String(minor).padStart(exponent + 1, '0')
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}

/** Any ISO instant as the QR's UTC time stamp, truncated to whole seconds. */
export function zatcaTimestamp(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('The instant is not a valid date')
  }
  return `${date.toISOString().slice(0, 19)}Z`
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export function encodeZatcaPhase1QrFields(fields: ZatcaQrFields): ZatcaQrResult {
  if (!UTC_SECONDS.test(fields.timestamp)) {
    return { ok: false, reason: 'The time stamp must be UTC YYYY-MM-DDTHH:MM:SSZ.' }
  }
  if (!AMOUNT.test(fields.total) || !AMOUNT.test(fields.vatTotal)) {
    return { ok: false, reason: 'Amounts must be non-negative decimals with a "." separator.' }
  }
  const values = [
    fields.sellerName,
    fields.vatNumber,
    fields.timestamp,
    fields.total,
    fields.vatTotal
  ]
  const parts: number[] = []
  for (const [index, value] of values.entries()) {
    const bytes = utf8(value)
    if (bytes.length === 0 || bytes.length > ZATCA_QR_MAX_VALUE_BYTES) {
      return { ok: false, reason: `TLV field ${index + 1} must be 1–255 UTF-8 bytes.` }
    }
    parts.push(index + 1, bytes.length, ...bytes)
  }
  const payload = toBase64(Uint8Array.from(parts))
  if (payload.length > ZATCA_QR_MAX_BASE64_LENGTH) {
    return { ok: false, reason: 'The QR payload exceeds 500 Base64 characters.' }
  }
  return { ok: true, payload }
}

export function encodeZatcaPhase1Qr(facts: ZatcaQrFacts): ZatcaQrResult {
  try {
    return encodeZatcaPhase1QrFields({
      sellerName: facts.sellerName,
      vatNumber: facts.vatNumber,
      timestamp: facts.timestamp,
      total: zatcaAmount(facts.totalMinor, facts.currencyExponent),
      vatTotal: zatcaAmount(facts.vatMinor, facts.currencyExponent)
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid amount' }
  }
}

/**
 * Parses a payload back into its five fields, or `null` when it is not EXACTLY tags 1–5 in order with
 * consistent lengths (the receipt gate uses this to refuse a QR of the wrong type or shape).
 */
export function decodeZatcaPhase1Qr(payload: string): ZatcaQrFields | null {
  if (payload.length === 0 || payload.length > ZATCA_QR_MAX_BASE64_LENGTH) {
    return null
  }
  const bytes = fromBase64(payload)
  if (bytes === null || toBase64(bytes) !== payload) {
    return null
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const values: string[] = []
  let offset = 0
  for (let tag = 1; tag <= 5; tag += 1) {
    if (offset + 2 > bytes.length || bytes[offset] !== tag) {
      return null
    }
    const length = bytes[offset + 1] ?? 0
    const start = offset + 2
    if (length === 0 || start + length > bytes.length) {
      return null
    }
    try {
      values.push(decoder.decode(bytes.subarray(start, start + length)))
    } catch {
      return null
    }
    offset = start + length
  }
  if (offset !== bytes.length) {
    return null
  }
  const [sellerName, vatNumber, timestamp, total, vatTotal] = values as [
    string,
    string,
    string,
    string,
    string
  ]
  return { sellerName, vatNumber, timestamp, total, vatTotal }
}
