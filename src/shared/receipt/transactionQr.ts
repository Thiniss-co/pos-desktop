/**
 * The non-fiscal transaction-reference QR (`txn-ref-v1`) and the receipt-snapshot canonical JSON.
 *
 *   THINIS-TXN/1;co=<company uuid>;doc=<sale|refund>;id=<local document uuid>;ts=<UTC YYYY-MM-DDTHH:MM:SSZ>;amt=<decimal>;cur=<ISO 4217>
 *
 * ASCII, at most 255 characters, fixed key order; the amount is the minor-unit total written with the
 * currency exponent (zero-padded, never trimmed). It carries no secret and no URL and is never labelled
 * as a fiscal QR. The backend twin is `app/Modules/POS/Support/TransactionReferenceQr.php`; both are
 * held to the byte-identical vectors in `tests/fixtures/transaction-qr-golden.json`. Same exports as the
 * POS-improvements Stage 6 module of the same path, which supersedes this one when the two merge.
 */

export const TRANSACTION_QR_PREFIX = 'THINIS-TXN/1'
export const TRANSACTION_QR_MAX_LENGTH = 255

export interface TransactionReferenceFacts {
  readonly companyUuid: string
  readonly documentKind: 'sale' | 'refund'
  readonly documentUuid: string
  /** Any ISO instant; encoded as UTC seconds. */
  readonly instant: string
  readonly totalMinor: number
  readonly currencyExponent: number
  readonly currency: string
}

export interface TransactionReferenceFields {
  readonly co: string
  readonly doc: 'sale' | 'refund'
  readonly id: string
  readonly ts: string
  readonly amt: string
  readonly cur: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PATTERN =
  /^THINIS-TXN\/1;co=([0-9a-f-]{36});doc=(sale|refund);id=([0-9a-f-]{36});ts=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z);amt=(\d+(?:\.\d{1,3})?);cur=([A-Z]{3})$/

/** Non-negative minor units with an exponent of 0–3, e.g. (1050, 2) → "10.50". */
export function transactionQrAmount(minor: number, exponent: number): string {
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

/** Any ISO instant as UTC, truncated to whole seconds. */
export function transactionQrTimestamp(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('The instant is not a valid date')
  }
  return `${date.toISOString().slice(0, 19)}Z`
}

export function encodeTransactionReferenceQr(facts: TransactionReferenceFacts): string {
  if (!UUID.test(facts.companyUuid) || !UUID.test(facts.documentUuid)) {
    throw new RangeError('The company and document identities must be lowercase uuids')
  }
  if (facts.documentKind !== 'sale' && facts.documentKind !== 'refund') {
    throw new RangeError('The document kind must be sale or refund')
  }
  if (!/^[A-Z]{3}$/.test(facts.currency)) {
    throw new RangeError('The currency must be an ISO 4217 code')
  }
  const text = [
    TRANSACTION_QR_PREFIX,
    `co=${facts.companyUuid}`,
    `doc=${facts.documentKind}`,
    `id=${facts.documentUuid}`,
    `ts=${transactionQrTimestamp(facts.instant)}`,
    `amt=${transactionQrAmount(facts.totalMinor, facts.currencyExponent)}`,
    `cur=${facts.currency}`
  ].join(';')
  if (text.length > TRANSACTION_QR_MAX_LENGTH) {
    throw new RangeError('The transaction reference exceeds 255 characters')
  }
  return text
}

/** The fields of a well-formed reference, or `null` (wrong prefix, order, or shape). */
export function decodeTransactionReferenceQr(text: string): TransactionReferenceFields | null {
  const match = PATTERN.exec(text)
  if (!match) {
    return null
  }
  return {
    co: match[1],
    doc: match[2] as 'sale' | 'refund',
    id: match[3],
    ts: match[4],
    amt: match[5],
    cur: match[6]
  }
}

/** Keys sorted recursively, no whitespace, UTF-8 unescaped: the receipt-snapshot canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    )
  }
  return value
}
