import { createHash } from 'crypto'

/**
 * The immutable invoice request hash — `desktop_invoice_syncs.request_hash` on the backend.
 *
 * This value is a journal-v1 entry input, so without reproducing it exactly this app cannot
 * recompute its own consumption chain and therefore cannot verify any coverage boundary at sequence
 * >= 1 (BH-04A §3.1). It is deliberately NOT `payloadHash()` (which key-sorts) and NOT a hash of the
 * stored `sync_queue.payload_json` bytes: the backend hashes
 * `json_encode(UploadDesktopInvoiceData::toHashableArray())`, built from Laravel's *validated*
 * request.
 *
 * Three things a naive port gets wrong, all pinned by
 * `tests/fixtures/desktop-invoice-request-hash-golden.json` (byte-identical to pos-backend's copy):
 *
 *  1. Key order and key set — camelCase PHP property declaration order at the top level, wrapping
 *     `items`/`payments` arrays that keep wire snake_case in `UploadDesktopInvoiceRequest::rules()`
 *     order, with keys absent from the request omitted rather than emitted as null.
 *  2. PHP's `json_encode` defaults — `/` becomes `\/` and every non-ASCII codepoint becomes a
 *     lowercase `\uXXXX` escape. `JSON.stringify` does neither, which matters for Arabic notes and
 *     for any reference containing a slash.
 *  3. `sold_at` is a Carbon instance by the time it is hashed, so it is normalized to UTC with six
 *     fractional digits and a `Z` suffix regardless of the offset the client sent.
 *
 * Everything here is derived from the frozen queued payload, never from today's catalog rows, and
 * never from an upload *response*. Anything it cannot reproduce exactly throws, and every caller
 * treats a throw as unverifiable evidence that denies spending rather than as a value to guess at.
 */

/** Item keys in `UploadDesktopInvoiceRequest::rules()` declaration order. */
const ITEM_KEYS = [
  'product_uuid',
  'barcode',
  'quantity',
  'unit_price_amount',
  'currency',
  'price_revision',
  'tax_id',
  'tax_mode',
  'tax_rate_basis_points',
  'tax_revision',
  'discount_type',
  'discount_value',
  'allocations'
] as const

const ALLOCATION_KEYS = [
  'allocation_uuid',
  'rights_generation',
  'consumption_sequence',
  'local_consumption_uuid',
  'quantity_milli'
] as const

const PAYMENT_KEYS = [
  'payment_method_uuid',
  'type',
  'amount',
  'loyalty_points',
  'reference',
  'paid_at'
] as const

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Laravel's `validated()` rebuilds nested arrays from the rule list, so it yields rule-declaration
 * key order and silently drops any key the request did not send. Reproduce both, and only both — a
 * key present with a null value is kept, because that is what the validator does.
 */
function pickInRuleOrder(source: JsonRecord, keys: readonly string[]): JsonRecord {
  const result: JsonRecord = {}

  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key]
    }
  }

  return result
}

const SOLD_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/

/**
 * Carbon's JSON form: UTC, six fractional digits, `Z`. An offset is a whole number of minutes, so it
 * shifts only the seconds — the fractional part is carried through unchanged rather than being
 * routed through a JavaScript `Date`, which cannot represent microseconds.
 */
export function carbonJsonTimestamp(value: string): string {
  const match = SOLD_AT_PATTERN.exec(value)

  if (!match) {
    throw new Error(`Unsupported sold_at timestamp for request hashing: ${value}`)
  }

  const [, year, month, day, hour, minute, second, fraction, zone] = match
  let offsetMinutes = 0

  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  }

  const utcMilliseconds =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ) -
    offsetMinutes * 60_000

  const utc = new Date(utcMilliseconds)
  const pad = (part: number, width = 2): string => String(part).padStart(width, '0')

  return (
    `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}` +
    `T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}` +
    `.${(fraction ?? '').padEnd(6, '0')}Z`
  )
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '/': '\\/',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t'
}

/** PHP `json_encode` string escaping: escaped slashes, `\uXXXX` for controls and all non-ASCII. */
function phpJsonString(value: string): string {
  let out = '"'

  for (const character of value) {
    const codePoint = character.codePointAt(0) as number

    if (SIMPLE_ESCAPES[character] !== undefined) {
      out += SIMPLE_ESCAPES[character]
    } else if (codePoint < 0x20 || codePoint > 0x7e) {
      // Non-BMP codepoints are emitted as the surrogate pair PHP emits.
      for (let index = 0; index < character.length; index++) {
        out += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`
      }
    } else {
      out += character
    }
  }

  return `${out}"`
}

/**
 * `json_encode($value)` with PHP's default flags, restricted to the value shapes an upload payload
 * can contain. A non-integer number throws rather than being formatted by a guess at PHP's
 * `serialize_precision`: every quantity in this contract is either an integer or a decimal string,
 * so a float here means the payload is not what this function was written for.
 */
export function phpJsonEncode(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Unsupported non-integer number in request hashing: ${value}`)
    }

    return String(value)
  }

  if (typeof value === 'string') {
    return phpJsonString(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(phpJsonEncode).join(',')}]`
  }

  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${phpJsonString(key)}:${phpJsonEncode(entry)}`)
      .join(',')}}`
  }

  throw new Error(`Unsupported value type in request hashing: ${typeof value}`)
}

/**
 * The exact array `UploadDesktopInvoiceData::toHashableArray()` produces for this payload.
 *
 * @param payload the frozen queued upload body, parsed from `sync_queue.payload_json`
 */
export function invoiceHashableArray(payload: JsonRecord): JsonRecord {
  if (typeof payload.idempotency_key !== 'string' || typeof payload.sold_at !== 'string') {
    throw new Error('The queued upload payload is missing its idempotency key or sold_at')
  }

  const items = payload.items
  const payments = payload.payments

  if (!Array.isArray(items) || !Array.isArray(payments)) {
    throw new Error('The queued upload payload is missing its items or payments')
  }

  const discount = isRecord(payload.invoice_discount) ? payload.invoice_discount : {}
  const clientContractVersion = payload.client_contract_version ?? null

  const hashable: JsonRecord = {
    idempotencyKey: payload.idempotency_key,
    localInvoiceUuid: payload.local_invoice_uuid,
    catalogRevision: payload.catalog_revision,
    offlineNumber: payload.offline_number ?? null,
    soldAt: carbonJsonTimestamp(payload.sold_at),
    soldWhileOffline: payload.sold_while_offline ?? false,
    customerUuid: payload.customer_uuid ?? null,
    currency: payload.currency,
    taxMode: payload.tax_mode,
    items: items.map((item) => {
      if (!isRecord(item)) {
        throw new Error('The queued upload payload contains a malformed item')
      }

      const line = pickInRuleOrder(item, ITEM_KEYS)

      if (Array.isArray(line.allocations)) {
        line.allocations = line.allocations.map((allocation) => {
          if (!isRecord(allocation)) {
            throw new Error('The queued upload payload contains a malformed allocation proof')
          }

          return pickInRuleOrder(allocation, ALLOCATION_KEYS)
        })
      }

      return line
    }),
    // `isset($discount['type'])` is false for both an absent and a null type, so both collapse to a
    // null discount type — and `$discount['value'] ?? 0` turns an absent or null value into 0.
    discountType: discount.type ?? null,
    discountValue: discount.value ?? 0,
    payments: payments.map((payment) => {
      if (!isRecord(payment)) {
        throw new Error('The queued upload payload contains a malformed payment')
      }

      return pickInRuleOrder(payment, PAYMENT_KEYS)
    }),
    notes: payload.notes ?? null
  }

  // A legacy (v1) request omits both keys entirely rather than sending them as null.
  if (clientContractVersion !== null) {
    hashable.clientContractVersion = clientContractVersion
    hashable.shiftUuid = payload.shift_uuid ?? null
  }

  return hashable
}

/** The bytes the backend hashes, as an exact string. */
export function invoiceHashableJson(payload: JsonRecord): string {
  return phpJsonEncode(invoiceHashableArray(payload))
}

/** `desktop_invoice_syncs.request_hash` for a frozen queued upload payload. */
export function invoiceRequestHash(payload: JsonRecord): string {
  return createHash('sha256').update(invoiceHashableJson(payload), 'utf8').digest('hex')
}

/** Convenience for the queued row: parses the frozen JSON, then hashes it. */
export function invoiceRequestHashFromPayloadJson(payloadJson: string): string {
  const parsed: unknown = JSON.parse(payloadJson)

  if (!isRecord(parsed)) {
    throw new Error('The queued upload payload is not a JSON object')
  }

  return invoiceRequestHash(parsed)
}
