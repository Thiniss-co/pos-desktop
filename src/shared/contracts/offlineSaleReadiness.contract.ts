import { z } from 'zod'

/**
 * PS6 §14.3 — why the offline sell window ends.
 *
 * The distinction between the first five and `none` is the substance of §14.3: an **authoritative
 * timestamp** (the authority's own ceiling, the licence, the subscription, its grace, or the catalog
 * contract) is a *time comparison* and produces a countdown. A **categorical** restriction — device
 * revoked, company inactive, permission removed, shift closed — is not a time comparison at all,
 * produces no countdown, and must be reported with its own reason rather than folded into "time
 * remaining".
 *
 * Collapsing the two is how an operator ends up watching a countdown that will never be the thing
 * that actually stops them selling.
 */
export const offlineSaleLimitingReasonSchema = z.enum([
  'authority_ceiling',
  'license_validation',
  'subscription_expiry',
  'subscription_grace',
  'catalog_contract',
  'none'
])

export type OfflineSaleLimitingReason = z.infer<typeof offlineSaleLimitingReasonSchema>

/**
 * PS6: a **non-blocking** inventory warning.
 *
 * The whole point of the physical-presence mode is that insufficient stock does not block a sale, so
 * this must never become a gate. It exists so a cashier can see that the book balance disagrees with
 * the shelf — which is information, not permission.
 */
export const offlineSaleInventoryWarningSchema = z
  .object({
    productUuid: z.string(),
    productName: z.string(),
    cachedQuantityMilli: z.number().int(),
    /** True when the cached balance is already at or below zero for this product. */
    atOrBelowZero: z.boolean()
  })
  .strict()

/**
 * PS6 §14.3 — the operator-facing readiness projection for offline selling.
 *
 * ## What this deliberately is not
 *
 * It is **not** a preparation requirement. In the new mode there is no mandatory "prepare stock"
 * step: a valid server-issued authority is what permits selling, and stock preparation is neither
 * necessary nor sufficient. The legacy preparation page remains for `allocation_exclusive`
 * deployments and is untouched.
 *
 * ## The countdown never resets
 *
 * `remainingSeconds` is derived every time from `MIN(not_after, every boundary observed since)`
 * minus trusted now, and can only ever move earlier. §14.3 is explicit that the window never resets
 * on launch, navigation, a refresh-only cycle, a retry that does not reach the server, or a clock
 * rollback. Only a genuinely new successful online validation mints a new authority and a new
 * window — and that happens on the server, not here.
 */
export const offlineSaleReadinessSchema = z
  .object({
    /** Whether this device currently holds a usable physical-presence authority. */
    mode: z.enum(['allocation_exclusive', 'physical_presence']),
    /**
     * True only when an authority is held AND its window currently covers trusted now.
     *
     * False is the ordinary state and is never an error: it means this device sells under the
     * legacy allocation rules.
     */
    canSellWithoutQuota: z.boolean(),
    authorityUuid: z.string().nullable(),
    notAfter: z.string().nullable(),
    remainingSeconds: z.number().int().nonnegative().nullable(),
    limitingReason: offlineSaleLimitingReasonSchema,
    /**
     * Categorical blocks, reported separately from the countdown because they are not time
     * comparisons (§14.3). An empty array does not mean "permitted" — `canSellWithoutQuota` says
     * that.
     */
    categoricalBlocks: z.array(z.string()),
    /** Sales committed locally and not yet acknowledged by the server. */
    pendingUploadCount: z.number().int().nonnegative(),
    lastSuccessfulSyncAt: z.string().nullable(),
    /** Advisory only. Never a gate. */
    inventoryWarnings: z.array(offlineSaleInventoryWarningSchema),
    /**
     * True when trusted time is unavailable, so no countdown can honestly be shown.
     *
     * Distinct from "expired": refusing to display a number is the correct answer when the clock
     * cannot be trusted, and inventing one from the wall clock is exactly what §14.3 forbids.
     */
    clockUntrusted: z.boolean()
  })
  .strict()

export type OfflineSaleReadiness = z.infer<typeof offlineSaleReadinessSchema>
export type OfflineSaleInventoryWarning = z.infer<typeof offlineSaleInventoryWarningSchema>
