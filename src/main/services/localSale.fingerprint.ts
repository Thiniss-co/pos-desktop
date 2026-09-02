import { createHash } from 'crypto'

/**
 * Deterministic JSON serialization: object keys are sorted recursively so the byte sequence never
 * depends on construction/insertion order, while arrays are serialized exactly in the order given
 * (order is semantic for `items`/`payments` — plan §1.3 — never sorted).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
    const result: Record<string, unknown> = {}

    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key])
    }

    return result
  }

  return value
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Decimal-string quantity ("1.5", "1.50", "1.500") to integer thousandths — one canonical form. */
export function quantityToMilli(quantity: string): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity.trim())

  if (!match) {
    throw new Error(`Invalid quantity for fingerprinting: ${quantity}`)
  }

  const whole = BigInt(match[1])
  const fraction = (match[2] ?? '').padEnd(3, '0')
  const milli = whole * 1000n + BigInt(fraction)

  if (milli > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Quantity out of range for fingerprinting: ${quantity}`)
  }

  return Number(milli)
}

/** Inverse of `quantityToMilli` — always renders exactly 3 fraction digits (e.g. "2.000"). */
export function milliToQuantity(milli: number): string {
  const whole = Math.trunc(milli / 1000)
  const fraction = Math.abs(milli % 1000)
    .toString()
    .padStart(3, '0')

  return `${whole}.${fraction}`
}

/** `TrimStrings`-equivalent: trim, then empty string becomes null. Mirrors the backend's rule. */
export function normalizeReference(reference: string | null): string | null {
  if (reference === null) {
    return null
  }

  const trimmed = reference.trim()

  return trimmed === '' ? null : trimmed
}

export interface FingerprintItem {
  readonly productUuid: string
  readonly quantity: string
  readonly discountType: 'fixed' | 'percentage' | null
  readonly discountValue: number
}

export interface FingerprintPayment {
  readonly paymentMethodUuid: string
  readonly amount: number
  readonly reference: string | null
}

export interface SemanticIntentInput {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly catalogRevision: string
  readonly customerUuid: string | null
  readonly items: readonly FingerprintItem[]
  readonly invoiceDiscountType: 'fixed' | 'percentage' | null
  readonly invoiceDiscountValue: number
  readonly payments: readonly FingerprintPayment[]
  readonly notes: string | null
}

/**
 * Plan §1.3: the semantic intent fingerprint. Order is preserved (never sorted) for `items` and
 * `payments` — array order is part of the semantic content, both because it changes the exact bytes
 * Laravel hashes downstream and because it is the allocation input. `catalogRevision` is included as
 * an expected-version guard only; it is never trusted as a source of prices/tax/totals.
 */
export function semanticIntentFingerprint(input: SemanticIntentInput): string {
  const discountValue = input.invoiceDiscountType === null ? 0 : input.invoiceDiscountValue

  return sha256Hex(
    canonicalJson({
      v: 1,
      companyUuid: input.companyUuid,
      deviceUuid: input.deviceUuid,
      userUuid: input.userUuid,
      catalogRevision: input.catalogRevision,
      customerUuid: input.customerUuid,
      items: input.items.map((item) => ({
        productUuid: item.productUuid,
        quantityMilli: quantityToMilli(item.quantity),
        discountType: item.discountType,
        discountValue: item.discountType === null ? 0 : item.discountValue
      })),
      invoiceDiscount: { discountType: input.invoiceDiscountType, discountValue },
      payments: input.payments.map((payment) => ({
        paymentMethodUuid: payment.paymentMethodUuid,
        amount: payment.amount,
        reference: normalizeReference(payment.reference)
      })),
      notes: input.notes
    })
  )
}

export interface OriginContextInput {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly originShiftUuid: string
  readonly originShiftObservedAt: string
  readonly originBranchUuid: string
  readonly originWarehouseUuid: string
}

/** Plan §1.3/§1.4: proves the immutable origin columns agree; recomputed from stored columns. */
export function originContextFingerprint(input: OriginContextInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      companyUuid: input.companyUuid,
      deviceUuid: input.deviceUuid,
      userUuid: input.userUuid,
      originShiftUuid: input.originShiftUuid,
      originShiftObservedAt: input.originShiftObservedAt,
      originBranchUuid: input.originBranchUuid,
      originWarehouseUuid: input.originWarehouseUuid
    })
  )
}

/** Plan §1.4: `payload_hash` proves the queued upload payload was never mutated after commit. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload))
}
