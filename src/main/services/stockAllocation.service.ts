import { randomUUID } from 'crypto'
import type { StockAllocationGrantRow } from '@shared/contracts/sale.contract'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'

export interface AllocationOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
}

export interface AllocationSplitEntry {
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly consumptionSequence: number
  readonly localConsumptionUuid: string
  readonly quantityMilli: number
}

export type AllocationSplitResult =
  | {
      readonly ok: true
      readonly perLine: readonly (readonly AllocationSplitEntry[])[]
      /**
       * PS4 §7.1: the quantity per line that grants did NOT cover, in the same order as `perLine`.
       *
       * Always present, and always all-zeroes unless the caller explicitly asked for the partial
       * mode. Returning it unconditionally rather than only in the new mode means a caller cannot
       * silently receive an under-covered split by forgetting to check for it.
       */
      readonly uncoveredMilliByLine: readonly number[]
    }
  | {
      readonly ok: false
      readonly code: 'stock-allocation-unavailable' | 'allocation-data-unavailable'
    }

/**
 * Pure allocation math (plan §3.5): deterministic, exact-integer-thousandths splitting across
 * pre-fetched usable grants, already ordered by (consume_until, server_sequence, allocation_uuid).
 * Demand is aggregated across `lineDemandsMilli` for the sufficiency check, but the split is
 * returned per input line (one entry array per line, in the same order), because the local schema
 * records consumption per invoice line, never a merged aggregate row. A single grant may be split
 * across two lines; each such split gets its own contiguous, gap-free consumption_sequence, tracked
 * only in this in-memory plan — nothing is written until the caller's transaction commits it.
 */
export function splitAllocations(params: {
  readonly grants: readonly StockAllocationGrantRow[]
  readonly remainingMilliByAllocation: ReadonlyMap<string, number>
  readonly nextSequenceByAllocation: ReadonlyMap<string, number>
  readonly lineDemandsMilli: readonly number[]
  readonly createUuid?: () => string
  /**
   * PS4 §7.1 — drain-first, best effort.
   *
   * With this false (the default, and the whole of legacy behaviour) an uncovered remainder is
   * `stock-allocation-unavailable` and the cart cannot be completed, exactly as today.
   *
   * With it true the grants are still drained FIRST — the split loop below is unchanged — and only
   * what they cannot cover becomes the remainder. That ordering matters: it means an available
   * grant is always consumed rather than left held while the same units are sold under physical
   * presence, which is what keeps allocation exposure falling rather than growing.
   */
  readonly allowUncoveredRemainder?: boolean
}): AllocationSplitResult {
  const createUuid = params.createUuid ?? randomUUID
  const remaining = new Map(params.remainingMilliByAllocation)
  const nextSequence = new Map(params.nextSequenceByAllocation)
  const perLine: AllocationSplitEntry[][] = []
  const uncoveredMilliByLine: number[] = []

  for (const demandMilli of params.lineDemandsMilli) {
    if (demandMilli <= 0) {
      perLine.push([])
      uncoveredMilliByLine.push(0)
      continue
    }

    let needed = demandMilli
    const entries: AllocationSplitEntry[] = []

    for (const grant of params.grants) {
      if (needed <= 0) {
        break
      }

      const available = remaining.get(grant.allocationUuid) ?? 0

      if (available <= 0) {
        continue
      }

      const take = Math.min(available, needed)
      const sequence = nextSequence.get(grant.allocationUuid) ?? 1

      entries.push({
        allocationUuid: grant.allocationUuid,
        rightsGeneration: grant.rightsGeneration,
        consumptionSequence: sequence,
        localConsumptionUuid: createUuid(),
        quantityMilli: take
      })

      remaining.set(grant.allocationUuid, available - take)
      nextSequence.set(grant.allocationUuid, sequence + 1)
      needed -= take
    }

    if (needed > 0 && params.allowUncoveredRemainder !== true) {
      return { ok: false, code: 'stock-allocation-unavailable' }
    }

    perLine.push(entries)
    uncoveredMilliByLine.push(needed > 0 ? needed : 0)
  }

  return { ok: true, perLine, uncoveredMilliByLine }
}

/**
 * Thin repository-backed wrapper around `splitAllocations()`.
 *
 * D2-B remains the default and is unchanged: a missing or insufficient allocation is
 * `stock-allocation-unavailable`, full stop, for every connectivity state. There is still no
 * fallback to shared or cached stock, and cached stock still authorizes nothing.
 *
 * PS4 adds one narrow exception, reachable only when the caller passes `allowUncoveredRemainder`
 * — which the commit path does only under a stored, valid, server-issued physical-presence
 * authority. In that mode the uncovered remainder is authorized by that authority, not by stock.
 */
export class StockAllocationService {
  constructor(
    private readonly repository: Pick<
      StockAllocationRepository,
      'getCapability' | 'usableGrantsForProduct' | 'spendableMilli' | 'nextConsumptionSequence'
    >,
    private readonly createUuid: () => string = randomUUID
  ) {}

  /**
   * The exact usable allocation remainder for one tracked product at the immutable origin, using
   * the *same* authority as `splitForProduct()`: current-snapshot, server-`active`, unexpired,
   * server-unconsumed grants minus pending local consumption. CP-5D-B's deficit calculation reads
   * this and nothing else — never catalog quantity, `stock_items.quantity`, `available_quantity`,
   * or `allocation_reserved_quantity`.
   */
  usableRemainingMilli(owner: AllocationOwner, productUuid: string, nowIso: string): number {
    if (this.repository.getCapability()?.state === 'unavailable') {
      return 0
    }

    return this.repository
      .usableGrantsForProduct(owner, productUuid, nowIso)
      .reduce((sum, grant) => sum + this.repository.spendableMilli(grant.allocationUuid), 0)
  }

  /**
   * @param allowUncoveredRemainder PS4 §7.1. Passed by the commit path ONLY when the device holds a
   *   stored, currently-valid, server-issued physical-presence authority. It is never inferred from
   *   cached stock, from connectivity, or from the absence of grants — stock authorizes nothing in
   *   this mode, and an authority is the only thing that does.
   */
  splitForProduct(
    owner: AllocationOwner,
    productUuid: string,
    lineDemandsMilli: readonly number[],
    nowIso: string,
    allowUncoveredRemainder = false
  ): AllocationSplitResult {
    // A successful bootstrap from an older backend explicitly records `unavailable`. It is not
    // safe to reuse grants retained from an earlier compatible snapshot as current authority.
    if (this.repository.getCapability()?.state === 'unavailable') {
      return { ok: false, code: 'allocation-data-unavailable' }
    }

    const grants = this.repository.usableGrantsForProduct(owner, productUuid, nowIso)
    const remainingMilliByAllocation = new Map(
      grants.map((grant) => [
        grant.allocationUuid,
        this.repository.spendableMilli(grant.allocationUuid)
      ])
    )
    const nextSequenceByAllocation = new Map(
      grants.map((grant) => [
        grant.allocationUuid,
        this.repository.nextConsumptionSequence(grant.allocationUuid)
      ])
    )

    return splitAllocations({
      grants,
      remainingMilliByAllocation,
      nextSequenceByAllocation,
      lineDemandsMilli,
      createUuid: this.createUuid,
      allowUncoveredRemainder
    })
  }
}
