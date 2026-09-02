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
  | { readonly ok: true; readonly perLine: readonly (readonly AllocationSplitEntry[])[] }
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
}): AllocationSplitResult {
  const createUuid = params.createUuid ?? randomUUID
  const remaining = new Map(params.remainingMilliByAllocation)
  const nextSequence = new Map(params.nextSequenceByAllocation)
  const perLine: AllocationSplitEntry[][] = []

  for (const demandMilli of params.lineDemandsMilli) {
    if (demandMilli <= 0) {
      perLine.push([])
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

    if (needed > 0) {
      return { ok: false, code: 'stock-allocation-unavailable' }
    }

    perLine.push(entries)
  }

  return { ok: true, perLine }
}

/**
 * Thin repository-backed wrapper around `splitAllocations()`. D2-B: never falls back to shared/
 * unreserved stock — a missing or insufficient allocation is `stock-allocation-unavailable`, full
 * stop, for every connectivity state.
 */
export class StockAllocationService {
  constructor(
    private readonly repository: Pick<
      StockAllocationRepository,
      'getCapability' | 'usableGrantsForProduct' | 'remainingMilli' | 'nextConsumptionSequence'
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
      .reduce((sum, grant) => sum + this.repository.remainingMilli(grant.allocationUuid), 0)
  }

  splitForProduct(
    owner: AllocationOwner,
    productUuid: string,
    lineDemandsMilli: readonly number[],
    nowIso: string
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
        this.repository.remainingMilli(grant.allocationUuid)
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
      createUuid: this.createUuid
    })
  }
}
