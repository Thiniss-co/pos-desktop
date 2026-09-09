import type {
  PreparationProductCoverage,
  PreparationQuantityState,
  PreparationReadiness,
  PreparationTimeState
} from '@shared/contracts/preparation.contract'
import type {
  PrepareOperationRow,
  PrepareOwner,
  PreparationRepository
} from '../repositories/preparation.repository'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import type { CatalogTrustedClock } from './catalogTrustedClock.service'

/**
 * CP4 — the readiness projection (plan §8.5, §8.6).
 *
 * ## The one thing this class exists to prevent
 *
 * A successful preparation result is a **historical fact about `prepared_at`**, not a renewable
 * entitlement. §8.5 is explicit: `ready_72h` records that a full window was established *at
 * `prepared_at`*. It does not mean 72 hours remain whenever the screen is opened, whenever a
 * response finally arrives, whenever the app restarts, or whenever a replay or bootstrap
 * re-presents the same decision.
 *
 * So the countdown is derived, every single time, from
 *
 * ```text
 * effective_ready_until = MIN(authority_ready_until, every boundary observed since)
 * remaining_seconds     = max(0, effective_ready_until - trusted_now)
 * ```
 *
 * `effective_ready_until` starts at the decision's immutable `authority_ready_until` and may only
 * ever move **earlier**. Nothing moves it later. Neither `prepared_at` nor `authority_ready_until`
 * is ever rewritten — the schema's triggers refuse it, and this class never tries.
 *
 * Worked example from §8.5: preparation succeeds at 10:00 with a 72-hour window; the screen is
 * opened at 12:00. It must read "prepared at 10:00 for 72 hours — about 70 hours remaining".
 * Showing "72 hours" again, or re-deriving the countdown from the moment the screen opened, is
 * forbidden. §13 lists it as a stop condition.
 *
 * ## Trusted time, not the wall clock
 *
 * `trusted_now` is the same non-regressing trusted time that governs every commit check (§8.3). A
 * clock rollback cannot lengthen a countdown here, and when trusted time is unavailable at all this
 * class reports `blocked` rather than guessing — an unanchored device has no basis for any claim
 * about remaining time.
 *
 * ## Three kinds of state, kept apart
 *
 * §8.5 requires immutable decision evidence, current reconciliation, and current permission/session
 * checks to stay separate. A stale success in the first never substitutes for a live check in the
 * third: an operator whose session changed or whose access was revoked is not "ready" merely
 * because a past decision said so.
 */

export interface PreparationLiveAuthority {
  /**
   * Boundaries observed *since* preparation. Each may only shorten the window.
   *
   * Supplied by the caller (CP4's reconnect orchestration) rather than read here, because these are
   * license, subscription, grace, catalog, session, and shift facts owned by other services. This
   * class's job is to reduce them correctly, not to re-derive them.
   */
  readonly observedBoundaries: readonly { readonly reason: string; readonly deadline: string }[]
  /**
   * A live restriction that blocks readiness **regardless of remaining time** (§8.5): a changed
   * session epoch, an observed device revocation, a lost permission.
   */
  readonly blockingRestriction: string | null
  /** The current local session epoch, compared against the operation's captured epoch. */
  readonly sessionEpoch: number
  /** The per-product advance targets, when known from the applied decision. */
  readonly lastTrustedObservationAt: string | null
}

export interface PreparationReadinessDependencies {
  readonly preparation: Pick<
    PreparationRepository,
    'latestAppliedOperation' | 'unresolvedOperations' | 'outcomes' | 'findCycle' | 'cycleProducts'
  >
  readonly stockAllocations: Pick<
    StockAllocationRepository,
    'usableGrantsForProduct' | 'spendableMilli'
  >
  readonly trustedClock: CatalogTrustedClock
}

function secondsBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return 0
  }

  return Math.max(0, Math.floor((to - from) / 1000))
}

export class PreparationReadinessService {
  constructor(private readonly dependencies: PreparationReadinessDependencies) {}

  project(owner: PrepareOwner, authority: PreparationLiveAuthority): PreparationReadiness {
    const unresolved = this.dependencies.preparation
      .unresolvedOperations(owner)
      .map((operation) => ({
        operationUuid: operation.operationUuid,
        state: operation.state,
        productCount: operation.selectedProductUuids.length
      }))

    const trusted = this.dependencies.trustedClock.now()
    const operation = this.dependencies.preparation.latestAppliedOperation(owner)

    if (operation === null) {
      // Nothing has been prepared. An unresolved operation is *not* a preparation: §8.6 forbids
      // rendering `ambiguous` or `discovered_pending_replay` as a successful one, so it appears
      // only in `unresolvedOperations`.
      return this.emptyReadiness(unresolved, trusted?.now.toISOString() ?? null)
    }

    if (trusted === null) {
      // No trusted-time anchor at all. Reporting a countdown from the wall clock here is exactly the
      // rollback attack §8.3 fences, so readiness is blocked rather than estimated.
      return {
        ...this.emptyReadiness(unresolved, null),
        time: {
          ...this.emptyReadiness(unresolved, null).time,
          state: 'blocked',
          preparedAt: operation.preparedAt,
          requestedDurationSeconds: operation.requiredDurationSeconds,
          originalResult: operation.result,
          newlyObservedRestriction: 'trusted_time_unavailable'
        }
      }
    }

    const trustedNowIso = trusted.now.toISOString()
    const effective = this.effectiveReadyUntil(operation, authority)
    const remainingSeconds = secondsBetween(trustedNowIso, effective.deadline)
    const quantity = this.projectQuantity(owner, operation, effective.deadline, trustedNowIso)

    return {
      available: true,
      time: {
        state: this.timeState({
          operation,
          authority,
          remainingSeconds,
          trustedNowIso,
          rollbackDetected: trusted.rollbackDetected
        }),
        preparedAt: operation.preparedAt,
        requestedDurationSeconds: operation.requiredDurationSeconds,
        originalResult: operation.result,
        effectiveReadyUntil: effective.deadline,
        remainingSeconds,
        limitingReason: effective.reason,
        tiedLimitingReasons: [...effective.tiedReasons],
        newlyObservedRestriction:
          authority.blockingRestriction ??
          (trusted.rollbackDetected ? 'trusted_time_rollback' : effective.newlyObserved),
        lastTrustedObservationAt: authority.lastTrustedObservationAt
      },
      quantity,
      blockedProducts: this.blockedProducts(operation),
      unresolvedOperations: unresolved
    }
  }

  /**
   * `MIN(authority_ready_until, every boundary observed since)` (§8.5).
   *
   * A boundary that is *later* than the decision's own is ignored outright rather than compared and
   * discarded silently: the point is that nothing can lengthen the window, and modelling that as
   * "the minimum wins" makes the impossibility structural instead of a rule someone must remember.
   */
  private effectiveReadyUntil(
    operation: PrepareOperationRow,
    authority: PreparationLiveAuthority
  ): {
    readonly deadline: string
    readonly reason: string | null
    readonly tiedReasons: readonly string[]
    readonly newlyObserved: string | null
  } {
    let deadline = operation.authorityReadyUntil ?? operation.requiredReadyUntil ?? ''
    let reason = operation.primaryLimitingReason
    let newlyObserved: string | null = null

    for (const boundary of authority.observedBoundaries) {
      if (deadline === '' || boundary.deadline < deadline) {
        deadline = boundary.deadline
        reason = boundary.reason
        newlyObserved = boundary.reason
      }
    }

    // §8.6 forbids hiding a second limiter at the same instant, so every guard landing on the
    // winning deadline is reported, not just the one that got there first.
    const tiedReasons: string[] = [
      ...(operation.authorityReadyUntil === deadline && operation.primaryLimitingReason !== null
        ? [operation.primaryLimitingReason]
        : []),
      ...authority.observedBoundaries
        .filter((boundary) => boundary.deadline === deadline)
        .map((boundary) => boundary.reason)
    ]

    return {
      deadline,
      reason,
      tiedReasons: [...new Set(tiedReasons)],
      newlyObserved
    }
  }

  private timeState(params: {
    readonly operation: PrepareOperationRow
    readonly authority: PreparationLiveAuthority
    readonly remainingSeconds: number
    readonly trustedNowIso: string
    readonly rollbackDetected: boolean
  }): PreparationTimeState {
    // A live check beats any historical success. §8.5: an operator whose session changed or whose
    // access was revoked is not "ready" merely because a past decision said so.
    if (params.authority.blockingRestriction !== null || params.rollbackDetected) {
      return 'blocked'
    }

    if (params.operation.capturedSessionEpoch !== params.authority.sessionEpoch) {
      return 'blocked'
    }

    if (params.remainingSeconds <= 0) {
      // Exact expiry (`trusted_now == effective_ready_until`) yields zero remaining and `expired`.
      // No tracked sale may commit; that is enforced by the sale path's own guards, not here.
      return 'expired'
    }

    const requested = params.operation.requiredDurationSeconds ?? 0

    // §8.6: the full-window state is permitted **only** while the whole requested window still
    // remains — that is, only at the moment of a successful preparation. From the next second
    // onward the honest statement is a countdown, which is a different state and a different string.
    if (params.operation.result === 'ready_72h' && params.remainingSeconds >= requested) {
      return 'ready_full_window'
    }

    if (params.operation.result === 'partial_time') {
      return 'partial_time'
    }

    return 'counting_down'
  }

  /**
   * §8.6 quantity coverage, per product.
   *
   * `Q72` (`coveredForWindowMilli`) counts only grants whose immutable `consume_until` reaches the
   * window's end. A grant ending exactly at the deadline qualifies, because no sale may commit *at*
   * the deadline (§8.1). An existing short-lived grant contributes zero to `Q72` while remaining
   * perfectly spendable before its own expiry — those are different questions and get different
   * numbers.
   */
  private projectQuantity(
    owner: PrepareOwner,
    operation: PrepareOperationRow,
    effectiveReadyUntil: string,
    trustedNowIso: string
  ): PreparationReadiness['quantity'] {
    const outcomes = this.dependencies.preparation.outcomes(operation.operationUuid)
    const products: PreparationProductCoverage[] = []

    for (const productUuid of operation.selectedProductUuids) {
      const grants = this.dependencies.stockAllocations.usableGrantsForProduct(
        owner,
        productUuid,
        trustedNowIso
      )

      let usableNowMilli = 0
      let coveredForWindowMilli = 0
      let shortLivedMilli = 0

      for (const row of grants) {
        // The repository's own reconciled figure: granted, minus the accepted server coverage
        // boundary, minus every local committed consumption above that boundary (§3.2). Deriving it
        // here as `granted - serverConsumed` would ignore local consumption the server has not yet
        // accepted and would over-report usable quantity by exactly the amount already sold.
        const spendable = this.dependencies.stockAllocations.spendableMilli(row.allocationUuid)
        usableNowMilli += spendable

        // §8.1: a grant ending exactly at the deadline qualifies, because no sale may commit *at*
        // the deadline. Anything ending earlier is spendable now but contributes zero to Q72.
        if (row.consumeUntil >= effectiveReadyUntil) {
          coveredForWindowMilli += spendable
        } else {
          shortLivedMilli += spendable
        }
      }

      const outcome = outcomes.find((entry) => entry.productUuid === productUuid)
      const targetMilli = outcome
        ? outcome.grantedQuantityMilli + outcome.windowQualifiedHoldMilli
        : 0

      products.push({
        productUuid,
        usableNowMilli,
        coveredForWindowMilli,
        // With `effective_ready_until` as the horizon these coincide; they are reported separately
        // because §8.6 asks for `Qat(product, time_ready_until)` explicitly when the supported
        // window is shorter than the requested one, and collapsing them would hide that.
        coveredForSupportedWindowMilli: coveredForWindowMilli,
        targetMilli,
        shortLivedMilli,
        heldNotSpendableMilli: outcome
          ? outcome.expiredHoldMilli + outcome.quarantinedHoldMilli
          : 0,
        state: this.productState(coveredForWindowMilli, targetMilli, usableNowMilli)
      })
    }

    return {
      state: this.aggregateQuantityState(products),
      products
    }
  }

  private productState(
    coveredMilli: number,
    targetMilli: number,
    usableNowMilli: number
  ): PreparationQuantityState {
    if (targetMilli > 0 && coveredMilli >= targetMilli) {
      return 'full'
    }

    if (coveredMilli > 0 || usableNowMilli > 0) {
      return 'partial'
    }

    return 'zero'
  }

  private aggregateQuantityState(
    products: readonly PreparationProductCoverage[]
  ): PreparationQuantityState {
    if (products.length === 0) {
      return 'zero'
    }

    if (products.every((product) => product.state === 'full')) {
      return 'full'
    }

    if (products.every((product) => product.state === 'zero')) {
      return 'zero'
    }

    return 'partial'
  }

  private blockedProducts(operation: PrepareOperationRow): PreparationReadiness['blockedProducts'] {
    const cycle = this.dependencies.preparation.findCycle(operation.cycleUuid)

    if (cycle === null) {
      return []
    }

    return this.dependencies.preparation
      .cycleProducts(cycle.cycleUuid)
      .filter((candidate) => candidate.disposition === 'blocked')
      .map((candidate) => ({
        productUuid: candidate.productUuid,
        reason: candidate.blockedReason ?? 'unknown'
      }))
  }

  private emptyReadiness(
    unresolvedOperations: PreparationReadiness['unresolvedOperations'],
    lastTrustedObservationAt: string | null
  ): PreparationReadiness {
    return {
      available: false,
      time: {
        state: 'not_prepared',
        preparedAt: null,
        requestedDurationSeconds: null,
        originalResult: null,
        effectiveReadyUntil: null,
        remainingSeconds: 0,
        limitingReason: null,
        tiedLimitingReasons: [],
        newlyObservedRestriction: null,
        lastTrustedObservationAt
      },
      quantity: { state: 'zero', products: [] },
      blockedProducts: [],
      unresolvedOperations
    }
  }
}
