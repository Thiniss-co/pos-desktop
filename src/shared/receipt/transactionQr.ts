/**
 * POS improvements, Stage 6 — the non-fiscal transaction-reference QR (`txn-ref-v1`).
 *
 * Agreed with the receipt-snapshot work (owner reprint) as an exact shared format:
 *   THINIS-TXN/1;co=<company uuid>;doc=<sale|refund>;id=<local document uuid>;ts=<UTC YYYY-MM-DDTHH:MM:SSZ>;amt=<decimal>;cur=<ISO 4217>
 * ASCII, at most 255 characters, fixed key order, amounts from minor units with the currency exponent.
 * It carries no secret and no URL and is never labelled ZATCA. `doc=refund` is used for refund
 * receipts; `doc=sale` for sales and historical copies.
 */
import { zatcaAmount, zatcaTimestamp } from './fiscalQr'

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

export function encodeTransactionReferenceQr(facts: TransactionReferenceFacts): string {
  if (!UUID.test(facts.companyUuid) || !UUID.test(facts.documentUuid)) {
    throw new RangeError('The company and document identities must be lowercase uuids')
  }
  if (!/^[A-Z]{3}$/.test(facts.currency)) {
    throw new RangeError('The currency must be an ISO 4217 code')
  }
  const text = [
    TRANSACTION_QR_PREFIX,
    `co=${facts.companyUuid}`,
    `doc=${facts.documentKind}`,
    `id=${facts.documentUuid}`,
    `ts=${zatcaTimestamp(facts.instant)}`,
    `amt=${zatcaAmount(facts.totalMinor, facts.currencyExponent)}`,
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
  const [, co, doc, id, ts, amt, cur] = match as unknown as [
    string,
    string,
    'sale' | 'refund',
    string,
    string,
    string,
    string
  ]
  return { co, doc, id, ts, amt, cur }
}

/**
 * Keys sorted recursively, no whitespace, UTF-8 unescaped — the receipt-snapshot canonical form (the
 * same rule as `localSale.fingerprint`'s, which main uses for sale fingerprints).
 */
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
