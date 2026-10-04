import { z } from 'zod'

// z.iso.datetime() rejects an offset by default; `offset: true` accepts both that and the "Z" form.
const isoDateTimeSchema = z.iso.datetime({ offset: true })

export const syncCountsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    uploading: z.number().int().nonnegative(),
    retryableError: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative()
  })
  .strict()

export const syncStatusSchema = z
  .object({
    state: z.enum(['idle', 'paused']),
    pausedReason: z.string().nullable(),
    counts: syncCountsSchema
  })
  .strict()

/**
 * The two terminal states a review list may show. `pending`, `uploading`, `retryable_error` and
 * `synced` are deliberately excluded: the first three are still in play and the last one succeeded,
 * so none of them is a failure an operator can act on.
 */
export const syncFailureStateSchema = z.enum(['conflict', 'rejected'])

/**
 * Keyset cursor over the exact drain order (`created_at ASC, local_queue_uuid ASC`). Offset
 * pagination is not used: rows can reach a terminal state between two pages, and an offset would
 * silently skip or repeat a real sale.
 */
export const syncFailureCursorSchema = z
  .object({
    createdAt: isoDateTimeSchema,
    localQueueUuid: z.uuid()
  })
  .strict()

export const SYNC_FAILURE_PAGE_DEFAULT_SIZE = 25
export const SYNC_FAILURE_PAGE_MAX_SIZE = 100

export const syncListFailuresInputSchema = z
  .object({
    cursor: syncFailureCursorSchema.nullish(),
    limit: z.number().int().min(1).max(SYNC_FAILURE_PAGE_MAX_SIZE).optional()
  })
  .strict()
  .optional()

/**
 * One terminal upload failure, projected for a read-only review screen.
 *
 * Deliberately absent: the frozen request payload, the idempotency key, tokens, headers, SQL, and
 * any unsanitized exception text. An operator needs to identify the sale and quote a support code —
 * nothing here is an authorization input, and nothing here can be used to re-send anything.
 *
 * Invoice fields are nullable because the projection LEFT JOINs `local_invoices`: a queue row whose
 * invoice is missing must stay visible and diagnosable rather than vanish from the list or be
 * filled in with invented values.
 */
export const syncFailureSchema = z
  .object({
    localQueueUuid: z.uuid(),
    invoiceLocalUuid: z.uuid().nullable(),
    offlineNumber: z.string().nullable(),
    totalAmount: z.number().int().nullable(),
    currency: z.string().nullable(),
    currencyExponent: z.number().int().min(0).max(3).nullable(),
    soldAt: z.string().nullable(),
    cashierUuid: z.uuid().nullable(),
    shiftUuid: z.uuid().nullable(),
    state: syncFailureStateSchema,
    backendCode: z.string().nullable(),
    message: z.string().nullable(),
    traceId: z.string().nullable(),
    queuedAt: z.string()
  })
  .strict()

export const syncFailurePageSchema = z
  .object({
    items: z.array(syncFailureSchema),
    nextCursor: syncFailureCursorSchema.nullable()
  })
  .strict()

/**
 * POS reliability — the Sync page's "needs attention" view (`sync:support-issues`).
 *
 * A read-only projection of durable main-process evidence (`attempt_allocation_dispatches`,
 * `legacy_dispatch_uncertainties`, `sale_attempts`). It is never a second source of truth: nothing
 * here can be acknowledged, retried, closed or deleted, and main resolves the owner from its own
 * session — the renderer names nothing.
 *
 * - `allocation-identity-conflict`: the server holds this request key with different bytes. It can
 *   never succeed and is never re-sent; support needs the reference.
 * - `allocation-request-invalid`: the recorded bytes can never pass the server's rules.
 * - `legacy-dispatch-uncertainty`: a payment from an earlier app version was cancelled; whether it
 *   reserved stock cannot be established. It stays open for review permanently.
 * - `allocation-request-pending`: a recorded request whose answer is not known yet. The workstation
 *   re-sends the exact same request by itself; no action is needed.
 */
export const supportIssueKindSchema = z.enum([
  'allocation-identity-conflict',
  'allocation-request-invalid',
  'legacy-dispatch-uncertainty',
  'allocation-request-pending',
  // Rev 4 §10.4: a completed sale held from upload because an earlier sale on the same stock
  // reservation was not accepted (or its sequence is broken). Nothing is re-sent or rewritten.
  'upload-held-by-predecessor',
  // POS improvements, Stage 2: a completed sale whose customer was created on this register and
  // whose create request was refused or needs permission. The sale is kept unchanged and waits.
  'upload-held-by-entity'
])

export const supportIssueLineSchema = z
  .object({
    /** From the installed catalog; `null` when the product is no longer in it. */
    productName: z.string().max(300).nullable(),
    quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/)
  })
  .strict()

export const supportIssueSchema = z
  .object({
    kind: supportIssueKindSchema,
    /** Stable, non-secret reference derived from the request/attempt identity (e.g. `AD-…`). */
    reference: z.string().regex(/^[A-Z]{2}-[0-9A-F]{12}$/),
    /** The server's trace id from the last answer, when there was one. */
    traceId: z.string().max(128).nullable(),
    occurredAt: isoDateTimeSchema,
    /** When the evidence was last updated (resolved/recorded); `null` while nothing changed. */
    updatedAt: isoDateTimeSchema.nullable(),
    /** False for another cashier's record on this workstation: details are then withheld. */
    ownedByCurrentUser: z.boolean(),
    /** `null` when withheld (another cashier's record). */
    lines: z.array(supportIssueLineSchema).max(200).nullable(),
    /** Pending requests only: how many times the exact same request has been sent. */
    sendCount: z.number().int().nonnegative().nullable(),
    /** Pending requests only: the server asked the workstation to wait until then. */
    nextAttemptAfter: isoDateTimeSchema.nullable(),
    /** Held uploads only: the support reference of the earlier sale it waits behind. */
    relatedReference: z
      .string()
      .regex(/^[A-Z]{2}-[0-9A-F]{12}$/)
      .nullable()
      .default(null)
  })
  .strict()

export const supportPaymentAwaitingSchema = z
  .object({
    reference: z.string().regex(/^[A-Z]{2}-[0-9A-F]{12}$/),
    claimedAt: isoDateTimeSchema,
    failureCode: z.string().max(64).nullable(),
    /** False when Retry can never succeed (identity conflict / invalid request). */
    retryAvailable: z.boolean(),
    legacyDispatchUnknown: z.boolean(),
    outstandingRequests: z.number().int().nonnegative(),
    traceId: z.string().max(128).nullable()
  })
  .strict()

export const SUPPORT_ISSUE_LIST_LIMIT = 100

export const syncSupportIssuesSchema = z
  .object({
    needsSupport: z.array(supportIssueSchema).max(SUPPORT_ISSUE_LIST_LIMIT * 2),
    automaticReconciliation: z.array(supportIssueSchema).max(SUPPORT_ISSUE_LIST_LIMIT),
    paymentAwaitingDecision: supportPaymentAwaitingSchema.nullable()
  })
  .strict()

export type SyncCounts = z.infer<typeof syncCountsSchema>
export type SyncStatus = z.infer<typeof syncStatusSchema>
export type SyncFailureState = z.infer<typeof syncFailureStateSchema>
export type SyncFailureCursor = z.infer<typeof syncFailureCursorSchema>
export type SyncListFailuresInput = z.infer<typeof syncListFailuresInputSchema>
export type SyncFailure = z.infer<typeof syncFailureSchema>
export type SyncFailurePage = z.infer<typeof syncFailurePageSchema>
export type SupportIssueKind = z.infer<typeof supportIssueKindSchema>
export type SupportIssueLine = z.infer<typeof supportIssueLineSchema>
export type SupportIssue = z.infer<typeof supportIssueSchema>
export type SupportPaymentAwaiting = z.infer<typeof supportPaymentAwaitingSchema>
export type SyncSupportIssues = z.infer<typeof syncSupportIssuesSchema>
