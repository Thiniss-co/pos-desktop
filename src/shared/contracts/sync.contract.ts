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

export type SyncCounts = z.infer<typeof syncCountsSchema>
export type SyncStatus = z.infer<typeof syncStatusSchema>
export type SyncFailureState = z.infer<typeof syncFailureStateSchema>
export type SyncFailureCursor = z.infer<typeof syncFailureCursorSchema>
export type SyncListFailuresInput = z.infer<typeof syncListFailuresInputSchema>
export type SyncFailure = z.infer<typeof syncFailureSchema>
export type SyncFailurePage = z.infer<typeof syncFailurePageSchema>
