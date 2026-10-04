import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type {
  AllocationAcquisitionOutcome,
  AllocationAcquisitionService
} from './allocationAcquisition.service'
import { isPublicAppError } from '../http/apiError'
import type { LocalSaleOutcome, LocalSaleService, PreparedSale } from './localSale.service'

export interface SaleCompletionDependencies {
  readonly localSale: Pick<
    LocalSaleService,
    'prepareCompletion' | 'prepareRetry' | 'runPrepared' | 'trackedDemand'
  > &
    Partial<Pick<LocalSaleService, 'hasUsableAuthority' | 'preliminaryInstant'>>
  readonly acquisition: Pick<AllocationAcquisitionService, 'acquire'>
  /**
   * Rev 4 §5.1: one single-flight license leg, used only when this attempt has no usable
   * physical-presence authority and the workstation is online. It never touches the catalog.
   */
  readonly renewal?: { licenseLeg(reason: 'checkout'): Promise<unknown> }
  readonly isOnline?: () => boolean
  readonly now?: () => Date
  /**
   * Fired after a sale actually commits, so the upload worker can drain the row that was just
   * queued instead of waiting for an unrelated trigger. Purely a scheduling hint: it grants no
   * authority, and the worker re-runs its whole authorization gate regardless. Never throws into
   * the sale path — a sale is complete whether or not anything is listening.
   */
  readonly onSaleCommitted?: () => void
  /**
   * POS reliability rev 3: fired after any completion run that reached allocation acquisition or
   * the business transaction (grants may have been ingested, stock consumed). A hint for the
   * renderer's local stock display only — it carries no quantities and grants no authority.
   */
  readonly onStockMayHaveChanged?: () => void
  /**
   * Receipt-printing plan §D-5 D — fired ONLY for a fresh, non-replay `committed` outcome (never
   * for `acknowledged`, a replay, or a restart), so auto-print can never fire twice for the same
   * sale from this call site. Carries the invoice's local UUID and owner tuple, which is all
   * `ReceiptPrintingService.runAutoPrintForSale` needs -- it re-reads and re-verifies everything
   * else itself. Wrapped the same way as `onSaleCommitted`: a printing failure must never turn a
   * completed sale into a failed one.
   */
  readonly onSaleCommittedForPrint?: (params: {
    readonly invoiceLocalUuid: string
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly userUuid: string
  }) => void
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

  /** `checkout:attempt-status`: whether main is still working on this key right now. */
  /** Rev 4 §8: whether ANY completion is in flight (the install gate waits for it to settle). */
  hasAnyInFlight(): boolean {
    return this.inFlight.size > 0
  }

  isInFlight(attemptKey: string): boolean {
    return this.inFlight.has(attemptKey)
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

  /**
   * Rev 4 §5.1 — preliminary eligibility at `t0`, synchronous. It only decides whether foreground
   * acquisition is skipped; the business transaction re-checks the authority at its own fresh `t1`.
   *  - `skip`: a usable physical-presence authority (or no trusted instant, which the transaction
   *    refuses as `clock-untrusted` anyway) — acquisition would only delay or block;
   *  - `renew`: none, but online — one license leg first (`renewThenCheck`);
   *  - `acquire`: the legacy allocation path decides.
   */
  private preliminaryEligibility(
    prepared: Extract<PreparedSale, { kind: 'ready' }>
  ): 'skip' | 'renew' | 'acquire' {
    const localSale = this.dependencies.localSale
    if (!localSale.hasUsableAuthority || !localSale.preliminaryInstant) {
      return 'acquire'
    }

    const t0 = localSale.preliminaryInstant()
    if (t0 === null || localSale.hasUsableAuthority(prepared, t0)) {
      return 'skip'
    }

    return this.dependencies.renewal && (this.dependencies.isOnline?.() ?? false)
      ? 'renew'
      : 'acquire'
  }

  /**
   * True → skip the foreground acquisition. That is the case when the renewal produced a usable
   * authority, and also when the leg could not reach the server at all (a transport failure): the
   * till is then effectively offline, and — exactly as the acquisition itself does offline — no
   * reservation request is sent into a dead network; the commit decides from local grants.
   */
  private async renewThenCheck(
    prepared: Extract<PreparedSale, { kind: 'ready' }>
  ): Promise<boolean> {
    const leg = await this.dependencies.renewal?.licenseLeg('checkout')
    if (isUnreachable(leg)) {
      return true
    }
    const localSale = this.dependencies.localSale
    const t0Fresh = localSale.preliminaryInstant?.() ?? null
    return t0Fresh === null || (localSale.hasUsableAuthority?.(prepared, t0Fresh) ?? false)
  }

  private async run(prepared: PreparedSale): Promise<LocalSaleOutcome> {
    if (prepared.kind === 'settled') {
      return prepared.outcome
    }

    const trackedLines = this.dependencies.localSale.trackedDemand(prepared)

    // An untracked-only cart never reaches the allocation endpoint at all. Rev 4 §5.1: nor does a
    // cart whose origin warehouse holds a usable physical-presence authority — stock authorizes
    // nothing there, so a foreground reservation must never delay or block the sale. Held grants
    // are still drained first inside the commit transaction.
    const eligibility = trackedLines.length > 0 ? this.preliminaryEligibility(prepared) : 'skip'
    const skipAcquisition =
      eligibility === 'renew' ? await this.renewThenCheck(prepared) : eligibility === 'skip'

    if (trackedLines.length > 0 && !skipAcquisition) {
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
          actorUserUuid: prepared.claimed.userUuid,
          trackedLines,
          nowIso: this.now().toISOString()
        }
      )

      if (acquisition.kind === 'blocked') {
        try {
          this.dependencies.onStockMayHaveChanged?.()
        } catch {
          // Display hint only.
        }
        return {
          outcome: 'failed',
          code: acquisition.code,
          attemptKey: prepared.claimed.attemptKey
        }
      }
    }

    const outcome = this.dependencies.localSale.runPrepared(prepared)

    try {
      this.dependencies.onStockMayHaveChanged?.()
    } catch {
      // A display hint must never affect the recorded sale outcome.
    }

    if (outcome.outcome === 'committed') {
      try {
        this.dependencies.onSaleCommitted?.()
      } catch {
        // The sale is committed and durable. A listener that throws must never turn a completed
        // sale into a failed one.
      }
      try {
        this.dependencies.onSaleCommittedForPrint?.({
          invoiceLocalUuid: outcome.invoice.localUuid,
          companyUuid: outcome.invoice.companyUuid,
          deviceUuid: outcome.invoice.deviceUuid,
          userUuid: outcome.invoice.userUuid
        })
      } catch {
        // Same guarantee as above: printing is never allowed to affect the recorded sale outcome.
      }
    }

    return outcome
  }
}

/** A license-leg result whose failure never reached the server (connection refused, timeout). */
function isUnreachable(leg: unknown): boolean {
  if (typeof leg !== 'object' || leg === null || (leg as { kind?: unknown }).kind !== 'transient') {
    return false
  }
  const error = (leg as { error?: unknown }).error
  // No HTTP status at all: the request never got an answer (a 5xx did reach the server).
  return isPublicAppError(error) && error.category === 'transport' && error.httpStatus === undefined
}
