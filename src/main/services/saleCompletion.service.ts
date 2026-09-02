import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type {
  AllocationAcquisitionOutcome,
  AllocationAcquisitionService
} from './allocationAcquisition.service'
import type { LocalSaleOutcome, LocalSaleService, PreparedSale } from './localSale.service'

export interface SaleCompletionDependencies {
  readonly localSale: Pick<
    LocalSaleService,
    'prepareCompletion' | 'prepareRetry' | 'runPrepared' | 'trackedDemand'
  >
  readonly acquisition: Pick<AllocationAcquisitionService, 'acquire'>
  readonly now?: () => Date
}

/**
 * Phase 3F CP-5D-C — the completion path in full:
 *
 *   1. the renderer submits the existing narrow sale intent;
 *   2. main claims (or resolves) its durable attempt and re-verifies the canonical intent;
 *   3. main resolves tracked-line allocation coverage from authoritative local state;
 *   4. main requests **only** the exact deficits, and only while genuinely connected;
 *   5. main atomically persists the strict server grant response;
 *   6. main re-reads and revalidates allocation authority from SQLite;
 *   7. the existing local-sale transaction repeats every authoritative guard;
 *   8. the sale commits exactly once, or fails closed with zero business writes.
 *
 * Steps 4-6 live in `AllocationAcquisitionService`; this class owns only the ordering, and in
 * particular the guarantee that no SQLite transaction is open while the HTTP call is in flight —
 * `prepareCompletion()` is read-only and `runPrepared()` has not started yet.
 *
 * An acquisition that ends `blocked` short-circuits before the business transaction. That is what
 * keeps an ambiguous outcome non-terminal: the attempt row stays `claimed` with its retained intent,
 * so the cashier's explicit retry replays the identical request under the identical derived
 * idempotency key instead of minting a new one.
 */
export class SaleCompletionService {
  private readonly now: () => Date
  /**
   * One in-flight operation per attempt key. `LocalSaleService.complete()` used to be wholly
   * synchronous, so main could not interleave two completions of the same attempt; awaiting the
   * network reopens that window. Coalescing here restores the guarantee the checkpoint requires —
   * a double submit produces one top-up request, one sale attempt, and at most one invoice — rather
   * than relying on the renderer's own (still present) single-flight guard, or on discovering the
   * duplicate later through a unique-index violation.
   */
  private readonly inFlight = new Map<string, Promise<LocalSaleOutcome>>()

  constructor(private readonly dependencies: SaleCompletionDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  async complete(attemptKey: string, intent: CheckoutIntent): Promise<LocalSaleOutcome> {
    return this.single(attemptKey, () =>
      this.run(this.dependencies.localSale.prepareCompletion(attemptKey, intent))
    )
  }

  async retry(attemptKey: string): Promise<LocalSaleOutcome> {
    return this.single(attemptKey, () =>
      this.run(this.dependencies.localSale.prepareRetry(attemptKey))
    )
  }

  private single(
    attemptKey: string,
    operation: () => Promise<LocalSaleOutcome>
  ): Promise<LocalSaleOutcome> {
    const existing = this.inFlight.get(attemptKey)

    if (existing) {
      return existing
    }

    const started = operation()
    this.inFlight.set(attemptKey, started)
    const clear = (): void => {
      if (this.inFlight.get(attemptKey) === started) {
        this.inFlight.delete(attemptKey)
      }
    }
    void started.then(clear, clear)

    return started
  }

  private async run(prepared: PreparedSale): Promise<LocalSaleOutcome> {
    if (prepared.kind === 'settled') {
      return prepared.outcome
    }

    const trackedLines = this.dependencies.localSale.trackedDemand(prepared)

    // An untracked-only cart never reaches the allocation endpoint at all.
    if (trackedLines.length > 0) {
      const acquisition: AllocationAcquisitionOutcome = await this.dependencies.acquisition.acquire(
        {
          attemptKey: prepared.claimed.attemptKey,
          owner: {
            companyUuid: prepared.claimed.companyUuid,
            deviceUuid: prepared.claimed.deviceUuid,
            // The immutable origin warehouse of *this* attempt, never a renderer-supplied one and
            // never a warehouse re-read after the claim.
            warehouseUuid: prepared.claimed.originWarehouseUuid
          },
          trackedLines,
          nowIso: this.now().toISOString()
        }
      )

      if (acquisition.kind === 'blocked') {
        return {
          outcome: 'failed',
          code: acquisition.code,
          attemptKey: prepared.claimed.attemptKey
        }
      }
    }

    return this.dependencies.localSale.runPrepared(prepared)
  }
}
