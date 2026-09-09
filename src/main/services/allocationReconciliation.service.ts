import type {
  AcceptedCoverageBoundary,
  AllocationRepresentation,
  IncomingCoverageBoundary,
  IncomingTerminalMarker,
  StockAllocationRepository
} from '../repositories/stockAllocation.repository'
import type { AllocationRecoveryRepository } from '../repositories/allocationRecovery.repository'
import {
  allocationJournalChainHash,
  allocationJournalInitialHash,
  isSha256Hex
} from './allocationJournal'

/**
 * BH-04B-3: validates and applies server reconciliation evidence — the BH-04A §3.1 coverage boundary
 * and the §9.2-4 terminal markers.
 *
 * Everything here is caller-transaction scoped: it holds no transaction of its own, so bootstrap,
 * top-up and invoice-upload each apply their evidence atomically with the rest of what that response
 * changes. Nothing is applied optimistically and re-checked later.
 *
 * The single organizing rule is that unverifiable evidence denies spending. Every rejection path
 * writes a durable hold rather than clamping a value into a plausible range, returning a default, or
 * quietly leaving the previous balance in force — a hold is the only outcome that is safe when this
 * device cannot prove what the server believes.
 */

export type CoverageRejection =
  | 'unknown-allocation'
  | 'foreign-owner'
  | 'generation-mismatch'
  | 'out-of-bounds'
  | 'malformed-hash'
  | 'incomplete-local-prefix'
  | 'sequence-beyond-local-history'
  | 'quantity-mismatch'
  | 'hash-mismatch'
  | 'unreconstructable-prefix'
  | 'impossible-spendable'
  | 'conflict'

export type CoverageOutcome =
  | { readonly kind: 'accepted'; readonly boundary: AcceptedCoverageBoundary }
  | { readonly kind: 'ignored-older' }
  | { readonly kind: 'rejected'; readonly reason: CoverageRejection; readonly detail: string }

export interface ReconciliationOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

export interface AllocationReconciliationDependencies {
  readonly stockAllocations: StockAllocationRepository
  readonly allocationRecoveries?: Pick<AllocationRecoveryRepository, 'markTerminalObservation'>
}

export class AllocationReconciliationService {
  constructor(private readonly dependencies: AllocationReconciliationDependencies) {}

  /**
   * Applies one bootstrap's reconciliation evidence. The caller must already hold the transaction
   * that writes the grants and the revision watermark, so markers, boundaries and the watermark all
   * commit together — a crash therefore leaves a consistent earlier state that the next bootstrap
   * reconciles, which is the bound BH-04A §10.3 places on guarantee 6.
   *
   * `markers` being `undefined` means the response said nothing about terminal allocations (a legacy
   * representation). That is emphatically not the same as an empty list, and neither is treated as
   * authority to remove an existing marker: terminal state is permanent for an allocation identity,
   * so omission from a list can never undo it.
   */
  applyBootstrap(input: {
    readonly owner: ReconciliationOwner
    readonly representation: AllocationRepresentation
    readonly coverage: readonly IncomingCoverageBoundary[]
    readonly markers: readonly IncomingTerminalMarker[] | undefined
    readonly observedAt: string
  }): readonly CoverageOutcome[] {
    if (input.markers !== undefined) {
      for (const marker of input.markers) {
        this.applyTerminalMarker(marker, input.owner, input.observedAt)
      }
    }

    return input.coverage.map((boundary) =>
      this.applyCoverage(boundary, input.owner, 'bootstrap', input.observedAt)
    )
  }

  /**
   * A terminal marker permanently removes an allocation identity's ability to authorize selling.
   *
   * The marker is stored even when the allocation is absent locally — that is the whole point of
   * keeping it in its own table with no foreign key. Without it, an older active envelope arriving
   * later would reintroduce a grant this device already knows is finished.
   *
   * Local invoice and consumption evidence is never deleted here. A terminal marker that contradicts
   * uncovered local consumption is an inconsistency to reconcile, not a licence to discard what the
   * cashier actually rang up, so the grant is additionally held and the evidence is left intact.
   */
  applyTerminalMarker(
    marker: IncomingTerminalMarker,
    owner: ReconciliationOwner,
    observedAt: string
  ): void {
    const repository = this.dependencies.stockAllocations

    repository.writeTerminalMarker({
      ...marker,
      companyUuid: owner.companyUuid,
      deviceUuid: owner.deviceUuid,
      observedAt
    })
    this.dependencies.allocationRecoveries?.markTerminalObservation(
      marker.allocationUuid,
      observedAt
    )

    const grant = repository.findGrantByUuid(marker.allocationUuid)

    if (grant === null) {
      return
    }

    if (grant.companyUuid !== owner.companyUuid || grant.deviceUuid !== owner.deviceUuid) {
      return
    }

    const boundary = repository.findCoverageBoundary(marker.allocationUuid, grant.rightsGeneration)
    const uncovered = repository.committedQuantityAboveSequence(
      marker.allocationUuid,
      grant.rightsGeneration,
      boundary?.acceptedConsumptionSequence ?? 0
    )

    if (uncovered > 0) {
      repository.recordHold(
        marker.allocationUuid,
        grant.rightsGeneration,
        'terminal_conflict',
        `terminal ${marker.status} evidence arrived while ${uncovered} milli of local consumption is still uncovered`,
        observedAt
      )
    }
  }

  /**
   * Validates one published boundary against this device's own immutable evidence, then either
   * accepts it, ignores it as older, or rejects it and holds the grant.
   *
   * The checks are the BH-04A §3.1 list, in order, and each one is a reason a boundary cannot be
   * trusted rather than a reason to adjust it:
   *
   *  1. The allocation exists locally, is owned by this company and device, and the generation
   *     matches — evidence is keyed by the immutable `(allocation_uuid, rights_generation)` pair.
   *  2. The values are bounded safe integers and the hash is well formed.
   *  3. Monotonicity: a lower sequence is ignored outright; the same sequence with a different
   *     quantity or hash is a conflict, never an idempotent update.
   *  4. The complete contiguous local prefix `1..s` exists, and `s` does not exceed the highest
   *     sequence this device actually authored.
   *  5. The prefix quantity and the recomputed journal-v1 chain hash equal `q` and `h` exactly. For
   *     `s = 0` that means `q = 0` and the exact backend initial hash.
   *  6. The resulting spendable amount lies inside the grant.
   *
   * Lifecycle revision is deliberately absent from all of this. The device-wide revision does not
   * order consumption events, so an unchanged revision must never stop a newer valid boundary from
   * being accepted.
   */
  applyCoverage(
    incoming: IncomingCoverageBoundary,
    owner: ReconciliationOwner,
    source: AcceptedCoverageBoundary['source'],
    observedAt: string
  ): CoverageOutcome {
    const repository = this.dependencies.stockAllocations
    const reject = (reason: CoverageRejection, detail: string): CoverageOutcome => {
      // A rejected boundary always leaves the grant unspendable. `unknown-allocation` is the one
      // case with nothing to hold: there is no local grant, so there is nothing this device could
      // spend either, and inventing a hold row would only create state keyed to an identity it does
      // not have.
      if (reason !== 'unknown-allocation') {
        repository.recordHold(
          incoming.allocationUuid,
          incoming.rightsGeneration,
          reason === 'conflict' ? 'coverage_conflict' : 'coverage_inconsistent',
          detail,
          observedAt
        )
      }

      return { kind: 'rejected', reason, detail }
    }

    const grant = repository.findGrantByUuid(incoming.allocationUuid)

    if (grant === null) {
      return reject('unknown-allocation', 'no local grant carries this allocation identity')
    }
    if (grant.companyUuid !== owner.companyUuid || grant.deviceUuid !== owner.deviceUuid) {
      return reject('foreign-owner', 'the allocation belongs to another company or device')
    }
    if (grant.rightsGeneration !== incoming.rightsGeneration) {
      return reject(
        'generation-mismatch',
        `coverage names rights generation ${incoming.rightsGeneration} but the grant is at ${grant.rightsGeneration}`
      )
    }
    if (
      !Number.isSafeInteger(incoming.acceptedConsumptionSequence) ||
      incoming.acceptedConsumptionSequence < 0 ||
      !Number.isSafeInteger(incoming.acceptedConsumedQuantityMilli) ||
      incoming.acceptedConsumedQuantityMilli < 0 ||
      incoming.acceptedConsumedQuantityMilli > grant.grantedQuantityMilli
    ) {
      return reject(
        'out-of-bounds',
        'coverage sequence or quantity is outside the safe integer range or the grant'
      )
    }
    if (!isSha256Hex(incoming.acceptedChainHash)) {
      return reject('malformed-hash', 'coverage chain hash is not lowercase sha256 hex')
    }

    const stored = repository.findCoverageBoundary(
      incoming.allocationUuid,
      incoming.rightsGeneration
    )

    if (stored !== null) {
      if (incoming.acceptedConsumptionSequence < stored.acceptedConsumptionSequence) {
        // Coverage never regresses. An older bootstrap or a replayed upload response arriving after
        // newer evidence is discarded, and — importantly — is not a conflict, so it holds nothing.
        return { kind: 'ignored-older' }
      }

      if (incoming.acceptedConsumptionSequence === stored.acceptedConsumptionSequence) {
        const identical =
          incoming.acceptedConsumedQuantityMilli === stored.acceptedConsumedQuantityMilli &&
          incoming.acceptedChainHash === stored.acceptedChainHash

        if (!identical) {
          return reject(
            'conflict',
            `sequence ${incoming.acceptedConsumptionSequence} was already accepted with a different quantity or chain hash`
          )
        }

        return { kind: 'accepted', boundary: { ...stored, observedAt: stored.observedAt } }
      }
    }

    const entries = repository.journalEntriesFor(incoming.allocationUuid, incoming.rightsGeneration)
    const highestLocalSequence = entries.reduce(
      (highest, entry) => Math.max(highest, entry.consumptionSequence),
      0
    )

    if (incoming.acceptedConsumptionSequence > highestLocalSequence) {
      return reject(
        'sequence-beyond-local-history',
        `coverage claims sequence ${incoming.acceptedConsumptionSequence} but this device authored at most ${highestLocalSequence}`
      )
    }

    const prefix = entries.filter(
      (entry) => entry.consumptionSequence <= incoming.acceptedConsumptionSequence
    )

    if (prefix.length !== incoming.acceptedConsumptionSequence) {
      return reject(
        'incomplete-local-prefix',
        `coverage needs the complete prefix 1..${incoming.acceptedConsumptionSequence} but only ${prefix.length} local rows exist`
      )
    }

    const prefixQuantity = prefix.reduce((total, entry) => total + entry.quantityMilli, 0)

    if (prefixQuantity !== incoming.acceptedConsumedQuantityMilli) {
      return reject(
        'quantity-mismatch',
        `the local prefix totals ${prefixQuantity} milli but coverage claims ${incoming.acceptedConsumedQuantityMilli}`
      )
    }

    let recomputedHash: string

    if (incoming.acceptedConsumptionSequence === 0) {
      recomputedHash = allocationJournalInitialHash(
        incoming.allocationUuid,
        incoming.rightsGeneration
      )
    } else {
      const missing = prefix.find(
        (entry) =>
          entry.rightsGeneration === null ||
          entry.invoiceIdempotencyKey === null ||
          entry.itemLineUuid === null ||
          entry.requestHash === null
      )

      if (missing !== undefined) {
        return reject(
          'unreconstructable-prefix',
          `local consumption at sequence ${missing.consumptionSequence} has no reconstructable journal evidence`
        )
      }

      try {
        recomputedHash = allocationJournalChainHash(
          incoming.allocationUuid,
          incoming.rightsGeneration,
          prefix.map((entry) => ({
            allocationUuid: entry.allocationUuid,
            rightsGeneration: entry.rightsGeneration as number,
            consumptionSequence: entry.consumptionSequence,
            localConsumptionUuid: entry.localUuid,
            invoiceIdempotencyKey: entry.invoiceIdempotencyKey as string,
            itemLineUuid: entry.itemLineUuid as string,
            quantityMilli: entry.quantityMilli,
            requestHash: entry.requestHash as string,
            entryHash: entry.entryHash,
            chainHash: entry.chainHash
          }))
        )
      } catch (error) {
        return reject(
          'unreconstructable-prefix',
          error instanceof Error ? error.message : 'the local journal could not be replayed'
        )
      }
    }

    if (recomputedHash !== incoming.acceptedChainHash) {
      return reject(
        'hash-mismatch',
        `the recomputed chain hash at sequence ${incoming.acceptedConsumptionSequence} does not match the published one`
      )
    }

    const uncovered = repository.committedQuantityAboveSequence(
      incoming.allocationUuid,
      incoming.rightsGeneration,
      incoming.acceptedConsumptionSequence
    )
    const spendable =
      grant.grantedQuantityMilli - incoming.acceptedConsumedQuantityMilli - uncovered

    if (!Number.isSafeInteger(spendable) || spendable < 0) {
      return reject(
        'impossible-spendable',
        `granted ${grant.grantedQuantityMilli} minus covered ${incoming.acceptedConsumedQuantityMilli} and uncovered ${uncovered} milli is not a possible balance`
      )
    }

    const accepted: AcceptedCoverageBoundary = {
      ...incoming,
      companyUuid: owner.companyUuid,
      deviceUuid: owner.deviceUuid,
      source,
      observedAt
    }

    repository.writeCoverageBoundary(accepted)

    // A hold is only ever cleared here, on the one path that has just proven the boundary against
    // this device's own immutable evidence. No fallback, retry or error handler may clear it.
    repository.clearHold(incoming.allocationUuid, incoming.rightsGeneration)

    return { kind: 'accepted', boundary: accepted }
  }
}
