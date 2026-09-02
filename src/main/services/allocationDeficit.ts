import { createHash } from 'crypto'
import { canonicalJson, milliToQuantity } from './localSale.fingerprint'

/**
 * Phase 3F CP-5D-B — the one main-owned calculation of "how much allocation is this exact cart
 * still missing?". Pure and total: it takes already-resolved authoritative facts and returns a
 * request, never reading the catalog, the network, or the renderer itself.
 *
 * The backend bounds below are transcribed from `TopUpStockAllocationsRequest::rules()`
 * (`items` min 1 / max 100, `items.*.quantity` decimal:0,3 between 0.001 and 999999.999). They are
 * enforced here so an unrepresentable demand fails closed as a whole, rather than being split into
 * several independently authorized requests — Laravel defines idempotent replay for one request
 * hash, not safe batch semantics across a partitioned one.
 */
export const TOP_UP_MAX_ITEMS = 100
export const TOP_UP_MIN_QUANTITY_MILLI = 1
export const TOP_UP_MAX_QUANTITY_MILLI = 999_999_999

/** One tracked cart line, already resolved against the single company-scoped catalog snapshot. */
export interface TrackedDemandLine {
  readonly lineId: string
  readonly productUuid: string
  readonly requiredMilli: number
}

export interface AllocationDeficitItem {
  readonly productUuid: string
  readonly requiredMilli: number
  readonly usableMilli: number
  readonly deficitMilli: number
}

export type AllocationDeficitResult =
  /** Every tracked line is already covered by usable local grants: no request may be made. */
  | { readonly kind: 'covered' }
  /** A request can be built exactly; `items` is deterministically ordered. */
  | {
      readonly kind: 'deficit'
      readonly items: readonly AllocationDeficitItem[]
      readonly affectedLineIds: readonly string[]
    }
  /** The exact demand cannot be represented inside the backend's own request bounds. */
  | { readonly kind: 'unrepresentable'; readonly affectedLineIds: readonly string[] }

/**
 * Aggregates duplicate lines per product, then subtracts the usable local grant remainder.
 *
 * `usableMilliByProduct` must be produced by the *same* authority the commit-time split uses
 * (`usableGrantsForProduct` + `remainingMilli`, bound to the current company, authenticated device,
 * assigned warehouse, product, contract version, revision, lifecycle status, generation, validity
 * window, granted amount and already-consumed amount). Catalog quantity, `stock_items.quantity`,
 * `available_quantity` and `allocation_reserved_quantity` are never inputs here.
 *
 * Ordering is `productUuid` ascending, which matches the backend's own `ksort($demands, SORT_STRING)`
 * over lowercase product UUIDs, so the same attempt always produces the same request bytes and
 * therefore the same server-side request hash.
 */
export function calculateAllocationDeficits(params: {
  readonly trackedLines: readonly TrackedDemandLine[]
  readonly usableMilliByProduct: ReadonlyMap<string, number>
}): AllocationDeficitResult {
  const requiredByProduct = new Map<string, number>()
  const lineIdsByProduct = new Map<string, string[]>()

  for (const line of params.trackedLines) {
    const productUuid = line.productUuid.toLowerCase()
    requiredByProduct.set(
      productUuid,
      (requiredByProduct.get(productUuid) ?? 0) + line.requiredMilli
    )
    const lineIds = lineIdsByProduct.get(productUuid) ?? []
    lineIds.push(line.lineId)
    lineIdsByProduct.set(productUuid, lineIds)
  }

  const items: AllocationDeficitItem[] = []
  const affectedLineIds: string[] = []

  for (const productUuid of [...requiredByProduct.keys()].sort()) {
    const requiredMilli = requiredByProduct.get(productUuid) as number
    const usableMilli = params.usableMilliByProduct.get(productUuid) ?? 0
    const deficitMilli = requiredMilli - usableMilli

    // A zero or negative deficit is already covered; it is never rounded up into a speculative
    // request, and a positive deficit is never rounded down.
    if (deficitMilli <= 0) {
      continue
    }

    items.push({ productUuid, requiredMilli, usableMilli, deficitMilli })
    affectedLineIds.push(...(lineIdsByProduct.get(productUuid) as string[]))
  }

  if (items.length === 0) {
    return { kind: 'covered' }
  }

  if (
    items.length > TOP_UP_MAX_ITEMS ||
    items.some(
      (item) =>
        !Number.isSafeInteger(item.deficitMilli) ||
        item.deficitMilli < TOP_UP_MIN_QUANTITY_MILLI ||
        item.deficitMilli > TOP_UP_MAX_QUANTITY_MILLI
    )
  ) {
    return { kind: 'unrepresentable', affectedLineIds }
  }

  return { kind: 'deficit', items, affectedLineIds }
}

export interface TopUpRequestBody {
  readonly idempotency_key: string
  readonly items: readonly { readonly product_uuid: string; readonly quantity: string }[]
}

/**
 * Builds the wire request for `POST /api/v1/desktop/stock-allocations/top-up`.
 *
 * **Idempotency key.** The bare `attemptKey` is *not* used directly. Laravel binds a stored
 * `stock_allocation_requests.idempotency_key` to the SHA-256 of its aggregated demand set and
 * answers any later request that reuses the key with different content with
 * `409 IDEMPOTENCY_CONFLICT` (`StockAllocationService::topUp()` / `assertSameHash()`). A single
 * sale attempt legitimately produces different demand sets across retries — a partially granted
 * top-up is persisted, so the next retry of the *same* attempt needs a strictly smaller deficit —
 * and reusing the raw attempt key there would turn a correct retry into a permanent conflict.
 *
 * Deriving the key from `(attemptKey, exact demand set)` keeps every property the checkpoint
 * requires: it is bound to the durable sale attempt, it is recomputed (never stored, never random)
 * from durable state alone, and an identical demand set always yields byte-identical bytes. So a
 * lost response, an ambiguous transport outcome, or a crash before persistence all replay under the
 * *same* key and receive Laravel's stored, effect-free result — while a genuinely different demand
 * set is a genuinely different request instead of a false conflict.
 */
export function buildTopUpRequest(
  attemptKey: string,
  items: readonly AllocationDeficitItem[]
): TopUpRequestBody {
  const wireItems = items.map((item) => ({
    product_uuid: item.productUuid,
    // Canonical three-decimal form. `WeightedAverageCostService::quantityToMilli()` reads exactly
    // three fractional digits, so this round-trips to the intended integer thousandths.
    quantity: milliToQuantity(item.deficitMilli)
  }))

  const idempotencyKey = createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        purpose: 'desktop-stock-allocation-top-up',
        attemptKey,
        items: items.map((item) => ({
          productUuid: item.productUuid,
          quantityMilli: item.deficitMilli
        }))
      })
    )
    .digest('hex')

  return { idempotency_key: idempotencyKey, items: wireItems }
}
