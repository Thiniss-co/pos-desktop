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
