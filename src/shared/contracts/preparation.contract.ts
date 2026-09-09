import { z } from 'zod'

/**
 * CP4 — the readiness projection the renderer is allowed to see (plan §8.5, §8.6).
 *
 * Main owns this shape entirely. The renderer receives a *projection*: categorical states, integer
 * milli quantities, and instants. It never receives, and can never supply, an authoritative
 * quantity, an ownership tuple, a grant right, or a clock — §4's invariants make that a boundary
 * property, not a convention.
 *
 * ## Why time and quantity are two separate members
 *
 * §8.1: time coverage and quantity coverage are independent and never substitute for one another. A
 * time-ready workstation can still sell only the finite allocated quantity, and ample quantity does
 * not extend an earlier time guard. §8.6 requires them rendered as two panels; keeping them as two
 * members of the contract is what stops a well-meaning UI from merging them into one number.
 */

/** §8.5: the four facts the UI must present separately, never merged. */
export const preparationTimeStateSchema = z.enum([
  /** The full requested window was established **and** still remains. Only at preparation. */
  'ready_full_window',
  /** Established for less than the requested window, with a named limiting guard. */
  'partial_time',
  /** Established, but time has since elapsed; a live countdown applies. */
  'counting_down',
  /** `remaining_seconds` reached zero. No tracked sale may commit. */
  'expired',
  /** A live check fails regardless of remaining time: session changed, revocation observed. */
  'blocked',
  /** Nothing has been prepared on this workstation. */
  'not_prepared'
])

export type PreparationTimeState = z.infer<typeof preparationTimeStateSchema>

export const preparationQuantityStateSchema = z.enum([
  'full',
  'partial',
  'zero',
  'reconciliation_required'
])

export type PreparationQuantityState = z.infer<typeof preparationQuantityStateSchema>

/**
 * §8.6: per-product quantity coverage.
 *
 * `usableNowMilli` is reconciled local spendable quantity *now* — not the quantity granted at
 * `prepared_at`. `coveredForWindowMilli` is `Q72`: it counts only grants whose immutable
 * `consume_until` reaches the window's end, so an existing short-lived grant contributes zero to it
 * while remaining perfectly spendable before its own expiry.
 */
export const preparationProductCoverageSchema = z
  .object({
    productUuid: z.string(),
    usableNowMilli: z.number().int().nonnegative(),
    coveredForWindowMilli: z.number().int().nonnegative(),
    coveredForSupportedWindowMilli: z.number().int().nonnegative(),
    targetMilli: z.number().int().nonnegative(),
    /** Usable now but expiring before the window ends — excluded from `coveredForWindowMilli`. */
    shortLivedMilli: z.number().int().nonnegative(),
    /** Server-known held quantity that is not spendable, when known. */
    heldNotSpendableMilli: z.number().int().nonnegative(),
    state: preparationQuantityStateSchema
  })
  .strict()

export type PreparationProductCoverage = z.infer<typeof preparationProductCoverageSchema>

export const preparationBlockedProductSchema = z
  .object({
    productUuid: z.string(),
    reason: z.string()
  })
  .strict()

/**
 * An operation that is `ambiguous` or `discovered_pending_replay` is **never** rendered as a
 * successful preparation (§8.6). It appears here instead, with its pending action.
 */
export const preparationUnresolvedOperationSchema = z
  .object({
    operationUuid: z.string(),
    state: z.string(),
    productCount: z.number().int().nonnegative()
  })
  .strict()

export const preparationReadinessSchema = z
  .object({
    /** `false` when the backend capability is off or this build has never prepared. */
    available: z.boolean(),

    time: z
      .object({
        state: preparationTimeStateSchema,
        /** The server's immutable decision anchor. Never re-derived locally. */
        preparedAt: z.string().nullable(),
        /** What was originally requested — 259,200 seconds for the approved target. */
        requestedDurationSeconds: z.number().int().nonnegative().nullable(),
        /** The original outcome at `prepared_at`: `ready_72h`, `partial_time`, and so on. */
        originalResult: z.string().nullable(),
        /**
         * §8.5: `MIN(authority_ready_until, every boundary observed since)`. It may only ever move
         * **earlier**. Nothing moves it later.
         */
        effectiveReadyUntil: z.string().nullable(),
        /** Derived live from trusted time. Never from the wall clock. */
        remainingSeconds: z.number().int().nonnegative(),
        /** The guard that produced the minimum, plus every guard tied at the same instant. */
        limitingReason: z.string().nullable(),
        tiedLimitingReasons: z.array(z.string()),
        /** A boundary, revocation, session or permission change observed *since* preparation. */
        newlyObservedRestriction: z.string().nullable(),
        lastTrustedObservationAt: z.string().nullable()
      })
      .strict(),

    quantity: z
      .object({
        state: preparationQuantityStateSchema,
        products: z.array(preparationProductCoverageSchema)
      })
      .strict(),

    /** Products the current cycle could not prepare, with their §7.2 reasons. */
    blockedProducts: z.array(preparationBlockedProductSchema),
    unresolvedOperations: z.array(preparationUnresolvedOperationSchema)
  })
  .strict()

export type PreparationReadiness = z.infer<typeof preparationReadinessSchema>

/**
 * The result of asking main to run a preparation cycle.
 *
 * Deliberately categorical. The renderer learns *what happened*, never a quantity it could act on
 * as authority, and it never learns an allocation identifier.
 */
export const preparationCycleResultSchema = z
  .object({
    outcome: z.enum([
      'applied',
      'blocked',
      'ambiguous',
      'discovered_pending_replay',
      'conflicted',
      'superseded_uncommitted',
      'unavailable'
    ]),
    reason: z.string().nullable()
  })
  .strict()

export type PreparationCycleResult = z.infer<typeof preparationCycleResultSchema>
