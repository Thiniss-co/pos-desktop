import { z } from 'zod'

/** `SellableCatalogPolicy::MaximumInvoiceTotal` / `MaximumLineTotal` (backend-frozen). */
const MAX_TOTAL = 900_000_000_000_000
/** `PosCalculator::PercentageScale` (backend-frozen). */
const MAX_BASIS_POINTS = 10_000

const isoDateTimeSchema = z.iso.datetime({ offset: true })

interface DiscountFields {
  readonly discountType: 'fixed' | 'percentage' | null
  readonly discountValue: number
}

/**
 * A discount's bound is type-dependent: `fixed` is capped at the invoice-total ceiling,
 * `percentage` at 10 000 basis points, and `null` admits only the value `0`. Mirrors
 * `PosCalculator::discount()` (`type === null && value !== 0` / `percentage > PercentageScale`).
 * Shared by the item-level and invoice-level discount schemas below — same rule, one place.
 */
function checkDiscountBounds(value: DiscountFields, ctx: z.RefinementCtx): void {
  const path = ['discountValue']

  if (value.discountType === null) {
    if (value.discountValue !== 0) {
      ctx.addIssue({ code: 'custom', path, message: 'A discount type is required for a value' })
    }
    return
  }

  const maximum = value.discountType === 'percentage' ? MAX_BASIS_POINTS : MAX_TOTAL
  if (value.discountValue > maximum) {
    ctx.addIssue({ code: 'custom', path, message: `Exceeds ${maximum}` })
  }
}

const discountShape = {
  discountType: z.enum(['fixed', 'percentage']).nullable(),
  discountValue: z.number().int().min(0)
} as const

const checkoutItemIntentSchema = z
  .object({
    id: z.string().min(1).max(64),
    productUuid: z.uuid(),
    quantity: z.string().max(16),
    ...discountShape
  })
  .strict()
  .superRefine(checkDiscountBounds)

const checkoutPaymentIntentSchema = z
  .object({
    id: z.string().min(1).max(64),
    paymentMethodUuid: z.uuid(),
    amount: z.number().int().min(0).max(MAX_TOTAL),
    reference: z.string().max(255).nullable()
  })
  .strict()

function duplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length
}

/**
 * What the renderer may send. Never accepted: unit price, currency, exponent, tax mode/rate/
 * revision, price revision, method type/activity, any total, company/device/user/shift identity,
 * or permissions — every one of those is re-resolved from main-owned state. `.strict()` at every
 * level makes an unknown key a rejection, not a silent drop.
 */
export const checkoutIntentSchema = z
  .object({
    draftRevision: z.number().int().nonnegative(),
    catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(checkoutItemIntentSchema).min(1).max(100),
    invoiceDiscount: z.object(discountShape).strict().superRefine(checkDiscountBounds),
    customerUuid: z.uuid().nullable(),
    payments: z.array(checkoutPaymentIntentSchema).min(1).max(20)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (duplicateIds(value.items.map((item) => item.id))) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate item id' })
    }

    if (duplicateIds(value.payments.map((payment) => payment.id))) {
      ctx.addIssue({ code: 'custom', path: ['payments'], message: 'Duplicate payment id' })
    }
  })

const cartLineTotalSchema = z
  .object({
    id: z.string(),
    subtotalAmount: z.number().int(),
    discountAmount: z.number().int(),
    taxAmount: z.number().int(),
    totalAmount: z.number().int()
  })
  .strict()

const cartTotalsSchema = z
  .object({
    lines: z.array(cartLineTotalSchema),
    subtotalAmount: z.number().int(),
    discountTotalAmount: z.number().int(),
    taxTotalAmount: z.number().int(),
    grandTotalAmount: z.number().int()
  })
  .strict()

const paymentRowSummarySchema = z
  .object({
    id: z.string(),
    methodUuid: z.uuid(),
    type: z.enum(['cash', 'card', 'other']),
    amount: z.number().int(),
    reference: z.string().nullable()
  })
  .strict()

const paymentSummarySchema = z
  .object({
    rows: z.array(paymentRowSummarySchema),
    paidTotalAmount: z.number().int(),
    changeDueAmount: z.number().int(),
    dueAmount: z.number().int()
  })
  .strict()

export const shiftUnavailableStateSchema = z.enum([
  'none',
  'paused',
  'closed',
  'cancelled',
  'reconciliation-required',
  'unknown',
  'foreign'
])

/**
 * `valid` is not an authorization token: no `validated` flag, no nonce, no cached decision, and
 * nothing is persisted from it. Phase 3F re-resolves, re-validates, and recalculates inside its
 * own transaction before it may write anything.
 */
export const checkoutPreviewOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('valid'),
      totals: cartTotalsSchema,
      payments: paymentSummarySchema,
      changeDueAmount: z.number().int(),
      dueAmount: z.number().int(),
      warnings: z.array(z.string()),
      catalogRevision: z.string(),
      draftRevision: z.number().int(),
      shiftObservedAt: isoDateTimeSchema,
      evaluatedAt: isoDateTimeSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal('invalid'),
      code: z.string(),
      field: z.string().nullable(),
      draftRevision: z.number().int()
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refresh-required'),
      draftRevision: z.number().int()
    })
    .strict(),
  z
    .object({
      outcome: z.literal('context-changed'),
      draftRevision: z.number().int()
    })
    .strict(),
  z
    .object({
      outcome: z.literal('shift-unavailable'),
      state: shiftUnavailableStateSchema
    })
    .strict()
])

export type CheckoutIntent = z.infer<typeof checkoutIntentSchema>
export type CheckoutPreviewOutcome = z.infer<typeof checkoutPreviewOutcomeSchema>
export type ShiftUnavailableState = z.infer<typeof shiftUnavailableStateSchema>

// --- Phase 3F CP-2: completion/recovery wire shapes -------------------------------------------
// Mirrors of the main-owned row shapes in `src/main/services/localSale.service.ts` /
// `src/shared/contracts/sale.contract.ts`, moved into the renderer-facing boundary so CP-3's IPC
// handlers and CP-4's renderer have one shared, validated shape to agree on. Every field here is a
// **result** the renderer only ever displays — never a value it may resubmit as authority.

const saleInvoiceItemResultSchema = z
  .object({
    localUuid: z.uuid(),
    invoiceLocalUuid: z.uuid(),
    lineIndex: z.number().int().nonnegative(),
    productUuid: z.uuid(),
    productName: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    unit: z.string().nullable(),
    trackStock: z.boolean(),
    quantityMilli: z.number().int(),
    unitPriceAmount: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    priceRevision: z.string(),
    taxUuid: z.uuid().nullable(),
    taxMode: z.enum(['none', 'inclusive', 'exclusive']),
    taxRateBasisPoints: z.number().int().min(0).max(MAX_BASIS_POINTS),
    taxRevision: z.string(),
    discountType: z.enum(['fixed', 'percentage']).nullable(),
    discountValue: z.number().int().min(0),
    subtotalAmount: z.number().int(),
    discountAmount: z.number().int(),
    taxAmount: z.number().int(),
    totalAmount: z.number().int(),
    createdAt: isoDateTimeSchema
  })
  .strict()

const saleInvoicePaymentResultSchema = z
  .object({
    localUuid: z.uuid(),
    invoiceLocalUuid: z.uuid(),
    paymentIndex: z.number().int().nonnegative(),
    paymentMethodUuid: z.uuid(),
    type: z.enum(['cash', 'card', 'other']),
    amount: z.number().int(),
    reference: z.string().nullable(),
    requiresReference: z.boolean(),
    paidAt: isoDateTimeSchema,
    methodSnapshotJson: z.string(),
    createdAt: isoDateTimeSchema
  })
  .strict()

const saleInvoiceResultSchema = z
  .object({
    localUuid: z.uuid(),
    attemptKey: z.string(),
    offlineNumber: z.string(),
    remoteUuid: z.uuid().nullable(),
    serverNumber: z.string().nullable(),
    syncStatus: z.enum([
      'pending',
      'uploading',
      'synced',
      'retryable_error',
      'conflict',
      'rejected'
    ]),
    syncAttempts: z.number().int().nonnegative(),
    lastSyncError: z.string().nullable(),
    syncedAt: isoDateTimeSchema.nullable(),
    companyUuid: z.uuid(),
    branchUuid: z.uuid(),
    warehouseUuid: z.uuid(),
    deviceUuid: z.uuid(),
    userUuid: z.uuid(),
    shiftUuid: z.uuid(),
    commitSessionEpoch: z.number().int().min(1),
    catalogRevision: z.string(),
    intentFingerprint: z.string(),
    customerUuid: z.uuid().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    currencyExponent: z.number().int().min(0).max(3),
    taxMode: z.enum(['none', 'inclusive', 'exclusive']),
    invoiceDiscountType: z.enum(['fixed', 'percentage']).nullable(),
    invoiceDiscountValue: z.number().int().min(0),
    subtotalAmount: z.number().int(),
    discountTotalAmount: z.number().int(),
    taxTotalAmount: z.number().int(),
    grandTotalAmount: z.number().int(),
    paidTotalAmount: z.number().int(),
    changeDueAmount: z.number().int(),
    dueAmount: z.number().int(),
    soldAt: isoDateTimeSchema,
    connectivityStateAtSale: z.enum(['online', 'offline', 'unknown']),
    soldWhileOffline: z.boolean(),
    notes: z.string().nullable(),
    commercialSnapshotJson: z.string(),
    uploadPayloadVersion: z.number().int(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict()

const saleResultSchema = z
  .object({
    invoice: saleInvoiceResultSchema,
    items: z.array(saleInvoiceItemResultSchema),
    payments: z.array(saleInvoicePaymentResultSchema)
  })
  .strict()

/** Every code `LocalSaleService` can hand back on a non-mutating or precondition-refused path. */
export const checkoutFailureCodeSchema = z.enum([
  'invalid-request',
  'permission-denied',
  'shift-unavailable',
  'shift-not-open',
  'shift-none',
  'shift-reconciliation-required',
  'shift-observation-foreign',
  'shift-observation-unknown',
  'workstation-unassigned',
  'refresh-required',
  'context-changed',
  'allocation-data-unavailable',
  'stock-allocation-unavailable',
  'allocation-acquisition-unresolved',
  'attempt-blocked',
  'attempt-conflict',
  'attempt-key-unavailable',
  'not-found',
  'already-committed',
  'attempt-unresolved',
  'integrity-inconsistency',
  'policy-blocked'
])

/**
 * `checkout:complete` / `checkout:retry-attempt` / `checkout:abandon-attempt` /
 * `checkout:acknowledge-attempt` all resolve to this union (plan §2.9). `replay: true` marks an
 * exact re-delivery of an already-decided result (T6/T8) rather than a fresh decision — the
 * renderer must never re-run success side effects (e.g. clearing the cart) on a replay it has
 * already seen.
 */
export const checkoutCompletionOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('committed'),
      attemptKey: z.string(),
      replay: z.boolean(),
      ...saleResultSchema.shape
    })
    .strict(),
  z
    .object({
      outcome: z.literal('acknowledged'),
      attemptKey: z.string(),
      replay: z.boolean(),
      ...saleResultSchema.shape
    })
    .strict(),
  z
    .object({
      outcome: z.literal('rejected'),
      attemptKey: z.string(),
      failureCode: z.string(),
      affectedLineIds: z.array(z.string().min(1).max(64)).optional()
    })
    .strict(),
  z
    .object({
      outcome: z.literal('abandoned'),
      attemptKey: z.string()
    })
    .strict(),
  z
    .object({
      outcome: z.literal('failed'),
      code: checkoutFailureCodeSchema,
      attemptKey: z.string().nullable(),
      blockingAttemptKey: z.string().optional()
    })
    .strict()
])

/**
 * `checkout:pending-attempts` (plan §2.9, read-only discovery). Deliberately narrower than the raw
 * `sale_attempts` row: never exposes `intent_json`, fingerprints, or origin columns to the
 * renderer boundary — only what the recovery banner needs to list and act on a result.
 */
export const recoveryBlockingAttemptSchema = z
  .object({
    attemptKey: z.string(),
    state: z.literal('claimed'),
    claimedAt: isoDateTimeSchema
  })
  .strict()

export const recoveryUnacknowledgedResultSchema = z
  .object({
    attemptKey: z.string(),
    committedAt: isoDateTimeSchema
  })
  .strict()

export const checkoutRecoveryStateSchema = z
  .object({
    blockingAttempt: recoveryBlockingAttemptSchema.nullable(),
    unacknowledgedResults: z.array(recoveryUnacknowledgedResultSchema),
    nextCursor: z
      .object({ committedAt: isoDateTimeSchema, attemptKey: z.string() })
      .strict()
      .nullable()
  })
  .strict()

// --- Phase 3F CP-3: the five `checkout:*` completion/recovery IPC input shapes (plan §2.9) -----
// `attemptKey` is the renderer-generated idempotency key (a real UUID, matching the `createUuid`
// convention used everywhere else in this codebase) — never resolved, reused, or defaulted by main.

const attemptKeySchema = z.uuid()

export const checkoutCompleteInputSchema = z
  .object({
    attemptKey: attemptKeySchema,
    intent: checkoutIntentSchema
  })
  .strict()

export const checkoutRetryAttemptInputSchema = z
  .object({
    attemptKey: attemptKeySchema
  })
  .strict()

export const checkoutAbandonAttemptInputSchema = z
  .object({
    attemptKey: attemptKeySchema
  })
  .strict()

export const checkoutAcknowledgeAttemptInputSchema = z
  .object({
    attemptKey: attemptKeySchema
  })
  .strict()

export const checkoutPendingAttemptsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    after: z
      .object({
        committedAt: isoDateTimeSchema,
        attemptKey: attemptKeySchema
      })
      .strict()
      .optional()
  })
  .strict()

export type CheckoutCompleteInput = z.infer<typeof checkoutCompleteInputSchema>
export type CheckoutRetryAttemptInput = z.infer<typeof checkoutRetryAttemptInputSchema>
export type CheckoutAbandonAttemptInput = z.infer<typeof checkoutAbandonAttemptInputSchema>
export type CheckoutAcknowledgeAttemptInput = z.infer<typeof checkoutAcknowledgeAttemptInputSchema>
export type CheckoutPendingAttemptsInput = z.infer<typeof checkoutPendingAttemptsInputSchema>

export type SaleInvoiceItemResult = z.infer<typeof saleInvoiceItemResultSchema>
export type SaleInvoicePaymentResult = z.infer<typeof saleInvoicePaymentResultSchema>
export type SaleInvoiceResult = z.infer<typeof saleInvoiceResultSchema>
export type SaleResult = z.infer<typeof saleResultSchema>
export type CheckoutFailureCode = z.infer<typeof checkoutFailureCodeSchema>
export type CheckoutCompletionOutcome = z.infer<typeof checkoutCompletionOutcomeSchema>
export type CheckoutRecoveryState = z.infer<typeof checkoutRecoveryStateSchema>
