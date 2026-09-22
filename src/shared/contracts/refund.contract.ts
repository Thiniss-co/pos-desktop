import { z } from 'zod'

/**
 * Plan §3/§5 (r5) — the refund domain contract. Shared by main (persistence, IPC handlers) and
 * renderer (store, service), following the same camelCase-row / snake_case-wire split as
 * `sale.contract.ts`.
 */

export const REFUND_SUBMISSION_STATES = [
  'prepared',
  'dispatched',
  'unresolved',
  'accepted',
  'rejected',
  'conflict',
  'cancelled'
] as const
export type RefundSubmissionState = (typeof REFUND_SUBMISSION_STATES)[number]

export const REFUND_TAX_MODES = ['none', 'inclusive', 'exclusive'] as const
export type RefundTaxMode = (typeof REFUND_TAX_MODES)[number]

/** Refund upload's actual supported set — narrower than the invoice upload's. Plan §5. */
export const REFUND_PAYMENT_TYPES = ['cash', 'card', 'other'] as const
export type RefundPaymentType = (typeof REFUND_PAYMENT_TYPES)[number]

export const REFUND_FEASIBILITY_TIERS = ['ok', 'soft', 'hard'] as const
export type RefundFeasibilityTier = (typeof REFUND_FEASIBILITY_TIERS)[number]

// ---------------------------------------------------------------------------------------------
// The refund read model attached to each invoice item (plan §2a). Optional: an older backend, or
// one that has not negotiated `refund_contract_version`, omits these entirely -- and their absence
// is never read as "everything is refundable" (plan §5 capability gate).
// ---------------------------------------------------------------------------------------------

export const refundFeasibilitySchema = z
  .object({
    tier: z.enum(REFUND_FEASIBILITY_TIERS),
    reasons: z.array(z.string())
  })
  .strict()
export type RefundFeasibility = z.infer<typeof refundFeasibilitySchema>

export const invoiceItemRefundReadModelSchema = z
  .object({
    refunded_quantity: z.string(),
    refundable_quantity: z.string(),
    refunded_subtotal_amount: z.number().int().min(0),
    refunded_discount_amount: z.number().int().min(0),
    refunded_tax_amount: z.number().int().min(0),
    refunded_total_amount: z.number().int().min(0),
    refund_feasibility: refundFeasibilitySchema
  })
  .partial()
export type InvoiceItemRefundReadModel = z.infer<typeof invoiceItemRefundReadModelSchema>

// ---------------------------------------------------------------------------------------------
// Local persistence rows
// ---------------------------------------------------------------------------------------------

export interface LocalRefundRow {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly invoiceRemoteUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly shiftUuid: string
  readonly currency: string
  readonly currencyExponent: number
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
  readonly refundedAt: string
  readonly stockReturned: boolean
  readonly reason: string | null
  readonly notes: string | null
  readonly requestJson: string
  readonly requestSha256: string
  readonly previewId: string
  readonly dispatchCount: number
  readonly submissionState: RefundSubmissionState
  readonly remoteUuid: string | null
  readonly refundNumber: string | null
  readonly cancelledAt: string | null
  readonly cancelledReason: string | null
  readonly lastErrorCode: string | null
  readonly lastErrorDetails: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LocalRefundItemRow {
  readonly localUuid: string
  readonly refundLocalUuid: string
  readonly lineIndex: number
  readonly invoiceItemRemoteUuid: string
  readonly productUuid: string
  readonly productName: string
  readonly quantityMilli: number
  readonly priorRefundedQuantityMilli: number
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
  readonly taxMode: RefundTaxMode
  readonly createdAt: string
}

export interface LocalRefundPaymentRow {
  readonly localUuid: string
  readonly refundLocalUuid: string
  readonly paymentIndex: number
  readonly paymentMethodUuid: string | null
  readonly type: RefundPaymentType
  readonly amount: number
  readonly reference: string | null
  readonly createdAt: string
}

// ---------------------------------------------------------------------------------------------
// R4 calculation (plan §1) -- integer minor units and integer milli-quantities throughout.
// ---------------------------------------------------------------------------------------------

export interface RefundR4LineInput {
  readonly invoiceItemRemoteUuid: string
  readonly productUuid: string
  readonly productName: string
  readonly taxMode: RefundTaxMode
  /** The invoice item's own persisted amounts (never a current price). */
  readonly originalQuantityMilli: number
  readonly originalSubtotalAmount: number
  readonly originalDiscountAmount: number
  readonly originalTaxAmount: number
  readonly originalTotalAmount: number
  /** What was ACTUALLY refunded before -- amounts, not just quantity (plan §2a). */
  readonly priorRefundedQuantityMilli: number
  readonly priorSubtotalAmount: number
  readonly priorDiscountAmount: number
  readonly priorTaxAmount: number
  readonly priorTotalAmount: number
  /** This selection's requested quantity. */
  readonly requestedQuantityMilli: number
  readonly feasibility: RefundFeasibility
}

export interface RefundR4LineResult {
  readonly invoiceItemRemoteUuid: string
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
}

export interface RefundR4Result {
  readonly lines: readonly RefundR4LineResult[]
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
}

// ---------------------------------------------------------------------------------------------
// IPC intents (plan §5). The renderer sends NARROW intents only -- no amounts, no totals, no
// identity, no idempotency key.
// ---------------------------------------------------------------------------------------------

export const refundLineSelectionSchema = z
  .object({
    invoiceItemRemoteUuid: z.uuid(),
    quantityMilli: z.number().int().min(1).max(999_999_999)
  })
  .strict()
export type RefundLineSelection = z.infer<typeof refundLineSelectionSchema>

export const refundsGetRefundableInputSchema = z
  .object({
    invoiceLocalUuid: z.string()
  })
  .strict()

export const refundsPreviewInputSchema = z
  .object({
    invoiceLocalUuid: z.string(),
    lines: z.array(refundLineSelectionSchema).min(1),
    stockReturned: z.boolean()
  })
  .strict()

export const refundsSubmitInputSchema = z
  .object({
    previewId: z.string(),
    invoiceLocalUuid: z.string(),
    lines: z.array(refundLineSelectionSchema).min(1),
    // r5 §5: required, never defaulted. The backend defaults an absent value to `true`, so silence
    // here would be an invisible decision crossing the boundary.
    stockReturned: z.boolean(),
    paymentMethodUuid: z.uuid().nullable(),
    reference: z.string().max(255).nullable().optional(),
    reason: z.string().max(255).nullable().optional(),
    notes: z.string().max(1000).nullable().optional()
  })
  .strict()

export const refundsResumeInputSchema = z
  .object({
    localRefundUuid: z.string()
  })
  .strict()

export const refundsCancelPreparedInputSchema = z
  .object({
    localRefundUuid: z.string()
  })
  .strict()

export const salesListInvoicesInputSchema = z
  .object({
    search: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().nullable().optional()
  })
  .strict()

export const salesGetInvoiceInputSchema = z
  .object({
    invoiceLocalUuid: z.string()
  })
  .strict()

// ---------------------------------------------------------------------------------------------
// IPC results -- renderer-facing projections. Money stays integer minor units.
// ---------------------------------------------------------------------------------------------

export interface RefundableInvoiceLine {
  readonly invoiceItemRemoteUuid: string
  readonly productName: string
  readonly quantitySold: string
  readonly quantityRefunded: string
  readonly quantityRefundable: string
  readonly feasibility: RefundFeasibility
  readonly taxMode: RefundTaxMode
}

export interface RefundableInvoice {
  readonly invoiceLocalUuid: string
  readonly invoiceRemoteUuid: string
  readonly offlineNumber: string
  readonly serverNumber: string | null
  readonly displayNumber: string
  readonly soldAt: string
  readonly currency: string
  readonly currencyExponent: number
  readonly grandTotalAmount: number
  readonly lines: readonly RefundableInvoiceLine[]
  /** False when the backend has not negotiated the refund contract or omits the read model. */
  readonly refundCapable: boolean
}

export interface RefundPreviewLine {
  readonly invoiceItemRemoteUuid: string
  readonly productName: string
  readonly quantityMilli: number
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
}

export interface RefundPreview {
  readonly previewId: string
  readonly invoiceLocalUuid: string
  readonly stockReturned: boolean
  readonly lines: readonly RefundPreviewLine[]
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
  readonly currency: string
  readonly currencyExponent: number
}

export interface RefundOutcome {
  readonly localRefundUuid: string
  readonly state: RefundSubmissionState
  readonly remoteUuid: string | null
  readonly refundNumber: string | null
  readonly errorCode: string | null
}

export interface SalesInvoiceSummary {
  readonly invoiceLocalUuid: string
  readonly offlineNumber: string
  readonly serverNumber: string | null
  readonly displayNumber: string
  readonly soldAt: string
  readonly grandTotalAmount: number
  readonly currency: string
  readonly currencyExponent: number
  readonly syncStatus: string
  readonly hasOpenRefund: boolean
}

export interface SalesInvoiceList {
  readonly invoices: readonly SalesInvoiceSummary[]
  readonly nextCursor: string | null
}

// ---------------------------------------------------------------------------------------------
// Sale detail (plan §6) -- the invoice, its line items, its payments, and any local refund
// history, for the SaleDetailPage. Local-first, mirroring the persisted row shapes.
// ---------------------------------------------------------------------------------------------

export interface SaleDetailItem {
  readonly localUuid: string
  readonly productName: string
  readonly sku: string | null
  readonly quantityMilli: number
  readonly unitPriceAmount: number
  readonly totalAmount: number
}

export interface SaleDetailPayment {
  readonly localUuid: string
  readonly type: string
  readonly amount: number
  readonly reference: string | null
}

export interface SaleDetailInvoice {
  readonly localUuid: string
  readonly offlineNumber: string
  readonly serverNumber: string | null
  readonly displayNumber: string
  readonly remoteUuid: string | null
  readonly syncStatus: string
  readonly soldAt: string
  readonly currency: string
  readonly currencyExponent: number
  readonly grandTotalAmount: number
}

export interface SaleDetailRefundSummary {
  readonly localUuid: string
  readonly submissionState: RefundSubmissionState
  readonly grandTotalAmount: number
  readonly refundNumber: string | null
  readonly remoteUuid: string | null
}

export interface SaleDetail {
  readonly invoice: SaleDetailInvoice
  readonly items: readonly SaleDetailItem[]
  readonly payments: readonly SaleDetailPayment[]
  readonly openRefund: SaleDetailRefundSummary | null
  readonly refunds: readonly SaleDetailRefundSummary[]
}
