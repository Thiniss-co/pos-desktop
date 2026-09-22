import { randomUUID } from 'node:crypto'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type {
  RefundableInvoice,
  RefundLineSelection,
  RefundOutcome,
  RefundPreview,
  RefundR4LineInput
} from '@shared/contracts/refund.contract'
import { calculateRefund } from '@shared/pos/refundCalculator'
import { DESKTOP_API_ROUTES, invoiceShowRoute } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  desktopBootstrapResourceSchema,
  desktopInvoiceShowResourceSchema
} from '../http/desktopResources.contract'
import { canonicalJson, sha256Hex } from './localSale.fingerprint'
import type {
  LocalRefundRepository,
  NewLocalRefund,
  NewLocalRefundItem,
  NewLocalRefundPayment
} from '../repositories/localRefund.repository'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { CatalogPaymentMethod } from '@shared/contracts/catalog.contract'
import type { RefundAccessService } from './refundAccess.service'
import type { ShiftAuthorityService } from './shiftAuthority.service'
import type { uploadRefund as UploadRefundFn } from '../sync/refundUpload.client'

const PREVIEW_TTL_MS = 15 * 60 * 1000
/** Refund upload's actual supported set (plan §5) -- narrower than invoice upload's. */
const REFUND_SUPPORTED_PAYMENT_TYPES = new Set(['cash', 'card', 'other'])

interface RetainedPreview {
  readonly previewId: string
  readonly invoiceLocalUuid: string
  readonly invoiceRemoteUuid: string
  readonly currency: string
  readonly currencyExponent: number
  readonly stockReturned: boolean
  readonly lines: readonly {
    readonly invoiceItemRemoteUuid: string
    readonly productUuid: string
    readonly productName: string
    readonly taxMode: 'none' | 'inclusive' | 'exclusive'
    readonly quantityMilli: number
    readonly priorRefundedQuantityMilli: number
    readonly subtotalAmount: number
    readonly discountAmount: number
    readonly taxAmount: number
    readonly totalAmount: number
  }[]
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
  readonly createdAtMs: number
  readonly owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly userUuid: string
  }
}

export interface RefundServiceDependencies {
  readonly apiClient: DesktopApiClient
  readonly localSale: LocalSaleRepository
  readonly localRefunds: LocalRefundRepository
  readonly access: RefundAccessService
  readonly shiftAuthority: ShiftAuthorityService
  readonly catalog: { listPaymentMethods(): CatalogPaymentMethod[] }
  readonly now?: () => Date
  readonly uploadRefund?: typeof UploadRefundFn
}

function validationError(
  message: string,
  backendCode: string,
  fieldErrors?: Record<string, string[]>
): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message,
    backendCode,
    retryable: false,
    fieldErrors
  })
}

/**
 * Plan §2/§3 (r5) — the refund orchestrator. Every entry point resolves owner/clock/identity from
 * main's own session and bootstrap state; the renderer supplies only invoice/line/payment
 * *selections*, never totals, timestamps, or the idempotency key (plan §5).
 *
 * ## Online-only, by construction
 *
 * `getRefundableInvoice` and `previewRefund` both make a live HTTP call — there is no local
 * fallback, because remaining refundable quantity and the confirmed-calculation contract are both
 * server-authoritative (plan §5 capability gate). A refund is never authored offline.
 *
 * ## The preview -> submit binding
 *
 * `previewRefund` computes R4 from a fresh server read and retains it in memory, keyed by
 * `previewId`. `submitRefund` requires that exact `previewId` and an unchanged selection; it never
 * recomputes from a fresher read at submit time, and never accepts a selection that does not match
 * what was reviewed. This is what "main retains the reviewed preview and freezes the exact
 * dispatched payload" means concretely (plan §3b).
 */
export class RefundService {
  private readonly previews = new Map<string, RetainedPreview>()
  private readonly now: () => Date

  constructor(private readonly dependencies: RefundServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  /**
   * Startup crash recovery (plan §3b): every `dispatched` row this device owns becomes
   * `unresolved`. Called once from `createApplicationServices`.
   */
  sweepOnStartup(owner: { readonly companyUuid: string; readonly deviceUuid: string }): number {
    return this.dependencies.localRefunds.sweepDispatchedToUnresolved(
      owner,
      this.now().toISOString()
    )
  }

  /**
   * Reads the invoice live and projects the refund read model. Requires the local invoice to be
   * `synced` (has a `remote_uuid`) -- an unsynced invoice has no server identity to refund against.
   */
  async getRefundableInvoice(invoiceLocalUuid: string): Promise<RefundableInvoice> {
    const local = this.dependencies.localSale.findInvoiceByLocalUuid(invoiceLocalUuid)

    if (!local) {
      throw validationError(
        'This sale could not be found on this workstation.',
        'refund_invoice_not_found'
      )
    }

    if (local.syncStatus !== 'synced' || !local.remoteUuid) {
      throw validationError(
        "This sale hasn't synced yet. It can't be refunded until it has.",
        'refund_invoice_not_synced'
      )
    }

    // Capability negotiation (plan §5): the ONLY evidence accepted that the backend enforces the
    // confirmed-calculation contract. Never inferred from the invoice read model's field presence.
    const bootstrapResponse = await this.dependencies.apiClient.request(
      DESKTOP_API_ROUTES.bootstrap
    )
    const bootstrap = desktopBootstrapResourceSchema.parse(bootstrapResponse)

    if (!bootstrap.refund_contract) {
      return {
        invoiceLocalUuid,
        invoiceRemoteUuid: local.remoteUuid,
        offlineNumber: local.offlineNumber,
        serverNumber: local.serverNumber,
        displayNumber: local.serverNumber ?? local.offlineNumber,
        soldAt: local.soldAt,
        currency: local.currency,
        currencyExponent: local.currencyExponent,
        grandTotalAmount: local.grandTotalAmount,
        lines: [],
        refundCapable: false
      }
    }

    const invoiceResponse = await this.dependencies.apiClient.request(
      invoiceShowRoute(local.remoteUuid)
    )
    const invoice = desktopInvoiceShowResourceSchema.parse(invoiceResponse)

    const linesWithReadModel = invoice.items.filter(
      (item) => item.refunded_quantity !== undefined && item.refund_feasibility !== undefined
    )

    // Tri-state (plan §5): the read model must be present on EVERY line, or the whole invoice is
    // treated as capability-unavailable rather than partially trusted.
    const refundCapable =
      linesWithReadModel.length === invoice.items.length && invoice.items.length > 0

    return {
      invoiceLocalUuid,
      invoiceRemoteUuid: local.remoteUuid,
      offlineNumber: local.offlineNumber,
      serverNumber: local.serverNumber,
      displayNumber: local.serverNumber ?? local.offlineNumber,
      soldAt: local.soldAt,
      currency: local.currency,
      currencyExponent: local.currencyExponent,
      grandTotalAmount: local.grandTotalAmount,
      refundCapable,
      lines: refundCapable
        ? invoice.items.map((item) => ({
            invoiceItemRemoteUuid: item.uuid,
            productName: item.product_name,
            quantitySold: item.quantity,
            quantityRefunded: item.refunded_quantity as string,
            quantityRefundable: item.refundable_quantity as string,
            feasibility: item.refund_feasibility as {
              tier: 'ok' | 'soft' | 'hard'
              reasons: string[]
            },
            taxMode: item.tax_mode
          }))
        : []
    }
  }

  /**
   * Computes R4 from a FRESH server read (never the desktop's own idea of remaining quantity) and
   * retains it, keyed by `previewId`, for `submitRefund` to bind against. Decision D2/D3: a `soft`
   * or `hard` line is refused here, by name, never silently dropped from the selection.
   */
  async previewRefund(input: {
    readonly invoiceLocalUuid: string
    readonly lines: readonly RefundLineSelection[]
    readonly stockReturned: boolean
  }): Promise<RefundPreview> {
    const owner = this.dependencies.shiftAuthority.captureContext()
    const local = this.dependencies.localSale.findInvoiceByLocalUuid(input.invoiceLocalUuid)

    if (!local || local.syncStatus !== 'synced' || !local.remoteUuid) {
      throw validationError(
        "This sale hasn't synced yet. It can't be refunded until it has.",
        'refund_invoice_not_synced'
      )
    }

    const invoiceResponse = await this.dependencies.apiClient.request(
      invoiceShowRoute(local.remoteUuid)
    )
    const invoice = desktopInvoiceShowResourceSchema.parse(invoiceResponse)

    const itemsByUuid = new Map(invoice.items.map((item) => [item.uuid, item]))
    const r4Inputs: RefundR4LineInput[] = []
    const blockedReasons: string[] = []

    for (const selection of input.lines) {
      const item = itemsByUuid.get(selection.invoiceItemRemoteUuid)

      if (!item || item.refund_feasibility === undefined) {
        throw validationError(
          'One or more selected lines could not be found on this invoice.',
          'refund_line_not_found'
        )
      }

      const feasibility = item.refund_feasibility as {
        tier: 'ok' | 'soft' | 'hard'
        reasons: string[]
      }

      if (feasibility.tier !== 'ok') {
        // Decision D2: both SOFT and HARD are blocked in this release. Named, never dropped.
        blockedReasons.push(
          `${item.product_name}:${feasibility.tier}:${feasibility.reasons.join(',')}`
        )
        continue
      }

      const [wholeQ, fracQ = ''] = String(item.quantity).split('.')
      const originalQuantityMilli = Number(wholeQ) * 1000 + Number(fracQ.padEnd(3, '0').slice(0, 3))
      const [wholeP, fracP = ''] = String((item.refunded_quantity as string) ?? '0.000').split('.')
      const priorRefundedQuantityMilli =
        Number(wholeP) * 1000 + Number(fracP.padEnd(3, '0').slice(0, 3))

      r4Inputs.push({
        invoiceItemRemoteUuid: item.uuid,
        productUuid: item.product_uuid,
        productName: item.product_name,
        taxMode: item.tax_mode,
        originalQuantityMilli,
        originalSubtotalAmount: item.subtotal_amount,
        originalDiscountAmount: item.discount_amount,
        originalTaxAmount: item.tax_amount,
        originalTotalAmount: item.total_amount,
        priorRefundedQuantityMilli,
        priorSubtotalAmount: (item.refunded_subtotal_amount as number) ?? 0,
        priorDiscountAmount: (item.refunded_discount_amount as number) ?? 0,
        priorTaxAmount: (item.refunded_tax_amount as number) ?? 0,
        priorTotalAmount: (item.refunded_total_amount as number) ?? 0,
        requestedQuantityMilli: selection.quantityMilli,
        feasibility
      })
    }

    if (blockedReasons.length > 0) {
      throw validationError(
        'One or more selected lines cannot be refunded because of an inconsistent refund history.',
        'refund_line_infeasible',
        { items: blockedReasons }
      )
    }

    if (r4Inputs.length === 0) {
      throw validationError('At least one refund line is required.', 'refund_no_lines_selected')
    }

    const result = calculateRefund(r4Inputs)

    if (result.grandTotalAmount <= 0) {
      // Decision D4: the backend cannot post a zero-value refund. Blocked here, never submitted.
      throw validationError(
        'There is no money to refund for this selection.',
        'refund_amount_zero_not_postable'
      )
    }

    const previewId = randomUUID()
    const nowMs = this.now().getTime()

    this.previews.set(previewId, {
      previewId,
      invoiceLocalUuid: input.invoiceLocalUuid,
      invoiceRemoteUuid: local.remoteUuid,
      currency: local.currency,
      currencyExponent: local.currencyExponent,
      stockReturned: input.stockReturned,
      lines: r4Inputs.map((line, index) => ({
        invoiceItemRemoteUuid: line.invoiceItemRemoteUuid,
        productUuid: line.productUuid,
        productName: line.productName,
        taxMode: line.taxMode,
        quantityMilli: line.requestedQuantityMilli,
        priorRefundedQuantityMilli: line.priorRefundedQuantityMilli,
        subtotalAmount: result.lines[index].subtotalAmount,
        discountAmount: result.lines[index].discountAmount,
        taxAmount: result.lines[index].taxAmount,
        totalAmount: result.lines[index].totalAmount
      })),
      subtotalAmount: result.subtotalAmount,
      discountTotalAmount: result.discountTotalAmount,
      taxTotalAmount: result.taxTotalAmount,
      grandTotalAmount: result.grandTotalAmount,
      createdAtMs: nowMs,
      owner
    })
    this.evictExpiredPreviews(nowMs)

    return {
      previewId,
      invoiceLocalUuid: input.invoiceLocalUuid,
      stockReturned: input.stockReturned,
      lines: r4Inputs.map((line, index) => ({
        invoiceItemRemoteUuid: line.invoiceItemRemoteUuid,
        productName: line.productName,
        quantityMilli: line.requestedQuantityMilli,
        subtotalAmount: result.lines[index].subtotalAmount,
        discountAmount: result.lines[index].discountAmount,
        taxAmount: result.lines[index].taxAmount,
        totalAmount: result.lines[index].totalAmount
      })),
      subtotalAmount: result.subtotalAmount,
      discountTotalAmount: result.discountTotalAmount,
      taxTotalAmount: result.taxTotalAmount,
      grandTotalAmount: result.grandTotalAmount,
      currency: local.currency,
      currencyExponent: local.currencyExponent
    }
  }

  private evictExpiredPreviews(nowMs: number): void {
    for (const [id, preview] of this.previews) {
      if (nowMs - preview.createdAtMs > PREVIEW_TTL_MS) {
        this.previews.delete(id)
      }
    }
  }

  /**
   * Freezes the reviewed preview into an immutable request, persists it (`prepared`), claims it for
   * dispatch, and sends it. New-refund guards ONLY (plan §4): current permission/feature/commercial
   * access, and a currently open shift. `stockReturned` and every payment field are validated and
   * resolved by main against the retained preview -- never trusted from the renderer as amounts.
   */
  async submitRefund(input: {
    readonly previewId: string
    readonly invoiceLocalUuid: string
    readonly lines: readonly RefundLineSelection[]
    readonly stockReturned: boolean
    readonly paymentMethodUuid: string | null
    readonly reference?: string | null
    readonly reason?: string | null
    readonly notes?: string | null
  }): Promise<RefundOutcome> {
    this.dependencies.access.assertCanRefund()
    const shift = this.dependencies.shiftAuthority.assertOpenForSell()
    const owner = this.dependencies.shiftAuthority.captureContext()

    const preview = this.previews.get(input.previewId)

    if (!preview || preview.invoiceLocalUuid !== input.invoiceLocalUuid) {
      throw validationError(
        'This refund preview is no longer available. Review the refund again.',
        'refund_preview_not_found'
      )
    }

    // The selection must match exactly what was reviewed -- no re-scoping at submit time.
    const previewKeys = preview.lines
      .map((l) => `${l.invoiceItemRemoteUuid}:${l.quantityMilli}`)
      .sort()
    const submittedKeys = input.lines
      .map((l) => `${l.invoiceItemRemoteUuid}:${l.quantityMilli}`)
      .sort()

    if (
      previewKeys.length !== submittedKeys.length ||
      previewKeys.some((key, index) => key !== submittedKeys[index]) ||
      preview.stockReturned !== input.stockReturned
    ) {
      throw validationError(
        'The refund selection changed since it was reviewed. Review it again.',
        'refund_preview_stale'
      )
    }

    const existingOpen = this.dependencies.localRefunds.findOpenForInvoice(input.invoiceLocalUuid)

    if (existingOpen) {
      throw validationError(
        'A refund is already in progress for this sale.',
        'refund_already_open',
        { invoice: [existingOpen.submissionState] }
      )
    }

    // r5 §5 -- the wire `type` is DERIVED from the resolved payment method's own snapshot, never
    // trusted from the renderer, because `validatePayments()` requires them to match exactly.
    const paymentType = this.resolveRefundPaymentType(input.paymentMethodUuid)

    const nowIso = this.now().toISOString()
    const localRefundUuid = randomUUID()

    const items = preview.lines.map((line, index) => ({
      invoice_item_uuid: line.invoiceItemRemoteUuid,
      quantity: milliToQuantityString(line.quantityMilli),
      line_index: index
    }))

    const expectedCalculation = {
      contract_version: 1,
      currency: preview.currency,
      stock_returned: input.stockReturned,
      lines: preview.lines.map((line) => ({
        invoice_item_uuid: line.invoiceItemRemoteUuid,
        quantity: milliToQuantityString(line.quantityMilli),
        prior_refunded_quantity: milliToQuantityString(line.priorRefundedQuantityMilli),
        subtotal_amount: line.subtotalAmount,
        discount_amount: line.discountAmount,
        tax_amount: line.taxAmount,
        total_amount: line.totalAmount,
        tax_mode: line.taxMode
      })),
      totals: {
        subtotal_amount: preview.subtotalAmount,
        discount_total_amount: preview.discountTotalAmount,
        tax_total_amount: preview.taxTotalAmount,
        grand_total_amount: preview.grandTotalAmount
      },
      payments: [
        {
          type: paymentType,
          payment_method_uuid: input.paymentMethodUuid,
          amount: preview.grandTotalAmount
        }
      ]
    }

    const wireBody = {
      idempotency_key: localRefundUuid,
      local_refund_uuid: localRefundUuid,
      invoice_uuid: preview.invoiceRemoteUuid,
      refunded_at: nowIso,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      stock_returned: input.stockReturned,
      refund_all: false, // r5 §2c: never sent, so a replay can never re-scope.
      items: items.map(({ invoice_item_uuid, quantity }) => ({ invoice_item_uuid, quantity })),
      payments: expectedCalculation.payments,
      expected_calculation: expectedCalculation
    }

    const requestJson = canonicalJson(wireBody)
    const requestSha256 = sha256Hex(requestJson)

    const newRefund: NewLocalRefund = {
      localUuid: localRefundUuid,
      invoiceLocalUuid: input.invoiceLocalUuid,
      invoiceRemoteUuid: preview.invoiceRemoteUuid,
      companyUuid: owner.companyUuid,
      deviceUuid: owner.deviceUuid,
      userUuid: owner.userUuid,
      shiftUuid: shift.shiftUuid,
      currency: preview.currency,
      currencyExponent: preview.currencyExponent,
      subtotalAmount: preview.subtotalAmount,
      discountTotalAmount: preview.discountTotalAmount,
      taxTotalAmount: preview.taxTotalAmount,
      grandTotalAmount: preview.grandTotalAmount,
      refundedAt: nowIso,
      stockReturned: input.stockReturned,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      requestJson,
      requestSha256,
      previewId: input.previewId,
      createdAt: nowIso
    }

    const newItems: NewLocalRefundItem[] = preview.lines.map((line, index) => ({
      localUuid: randomUUID(),
      refundLocalUuid: localRefundUuid,
      lineIndex: index,
      invoiceItemRemoteUuid: line.invoiceItemRemoteUuid,
      productUuid: line.productUuid,
      productName: line.productName,
      quantityMilli: line.quantityMilli,
      priorRefundedQuantityMilli: line.priorRefundedQuantityMilli,
      subtotalAmount: line.subtotalAmount,
      discountAmount: line.discountAmount,
      taxAmount: line.taxAmount,
      totalAmount: line.totalAmount,
      taxMode: line.taxMode,
      createdAt: nowIso
    }))

    const newPayments: NewLocalRefundPayment[] = [
      {
        localUuid: randomUUID(),
        refundLocalUuid: localRefundUuid,
        paymentIndex: 0,
        paymentMethodUuid: input.paymentMethodUuid,
        type: paymentType,
        amount: preview.grandTotalAmount,
        reference: input.reference ?? null,
        createdAt: nowIso
      }
    ]

    this.dependencies.localRefunds.insert(newRefund, newItems, newPayments)
    this.previews.delete(input.previewId)

    return this.dispatch(localRefundUuid)
  }

  /**
   * Resolves the selected payment method against the company's catalog and the refund-supported
   * type set (`cash | card | other` -- refund upload's actual, narrower contract, plan §5). `null`
   * means cash-in-hand with no stored method. A method of type `loyalty`, `bank_transfer` or
   * `wallet` is refused here: loyalty is reversed automatically and never chosen as a refund
   * payment, and the other two are simply not accepted by this endpoint.
   */
  private resolveRefundPaymentType(paymentMethodUuid: string | null): 'cash' | 'card' | 'other' {
    if (paymentMethodUuid === null) {
      return 'cash'
    }

    const method = this.dependencies.catalog
      .listPaymentMethods()
      .find((candidate) => candidate.uuid === paymentMethodUuid)

    if (!method || !method.isActive) {
      throw validationError(
        'The selected refund method is not available.',
        'refund_payment_method_unavailable'
      )
    }

    if (method.type === null || !REFUND_SUPPORTED_PAYMENT_TYPES.has(method.type)) {
      throw validationError(
        'This payment method cannot be used for a refund.',
        'refund_payment_method_unsupported'
      )
    }

    return method.type as 'cash' | 'card' | 'other'
  }

  /**
   * Resume: re-sends the EXACT frozen bytes of an `unresolved` (or still-`prepared`) refund. No
   * re-read, no recompute, no re-check of shift/quantity -- the replay contract (plan §4).
   */
  async resumeRefund(localRefundUuid: string): Promise<RefundOutcome> {
    const local = this.dependencies.localRefunds.findByLocalUuid(localRefundUuid)

    if (!local) {
      throw validationError('This refund could not be found.', 'refund_not_found')
    }

    if (local.submissionState !== 'unresolved' && local.submissionState !== 'prepared') {
      throw validationError(
        'This refund is not in a state that can be resumed.',
        'refund_not_resumable'
      )
    }

    return this.dispatch(localRefundUuid)
  }

  /** Auditable cancellation, permitted only before dispatch (plan §3b). */
  cancelPreparedRefund(localRefundUuid: string, reason: string | null = null): boolean {
    return this.dependencies.localRefunds.cancelIfPrepared(
      localRefundUuid,
      reason,
      this.now().toISOString()
    )
  }

  private async dispatch(localRefundUuid: string): Promise<RefundOutcome> {
    const nowIso = this.now().toISOString()
    const claimed = this.dependencies.localRefunds.claimForDispatch(localRefundUuid, nowIso)

    if (!claimed) {
      const current = this.dependencies.localRefunds.findByLocalUuid(localRefundUuid)

      if (current) {
        return toOutcome(current.localUuid, current)
      }

      throw validationError('This refund could not be dispatched.', 'refund_dispatch_failed')
    }

    const local = this.dependencies.localRefunds.findByLocalUuid(localRefundUuid)

    if (!local) {
      throw validationError('This refund could not be found after claiming it.', 'refund_not_found')
    }

    const uploader = this.dependencies.uploadRefund
    if (!uploader) {
      throw new Error('RefundService requires uploadRefund to be injected')
    }

    const outcome = await uploader(this.dependencies.apiClient, local.requestJson)
    const settledAt = this.now().toISOString()

    switch (outcome.kind) {
      case 'created':
      case 'duplicate':
        this.dependencies.localRefunds.markAccepted(
          localRefundUuid,
          { remoteUuid: outcome.refund.id, refundNumber: outcome.refund.refund_number },
          settledAt
        )
        break
      case 'rejected':
        this.dependencies.localRefunds.markRejected(
          localRefundUuid,
          outcome.errorCode,
          outcome.errorDetails,
          settledAt
        )
        break
      case 'conflict':
        this.dependencies.localRefunds.markConflict(
          localRefundUuid,
          outcome.errorCode,
          outcome.errorDetails,
          settledAt
        )
        break
      default:
        this.dependencies.localRefunds.markUnresolved(
          localRefundUuid,
          outcome.errorCode,
          outcome.errorDetails,
          settledAt
        )
    }

    const final = this.dependencies.localRefunds.findByLocalUuid(localRefundUuid)

    if (!final) {
      throw validationError('This refund could not be found after dispatch.', 'refund_not_found')
    }

    return toOutcome(localRefundUuid, final)
  }
}

function milliToQuantityString(milli: number): string {
  const whole = Math.trunc(milli / 1000)
  const fraction = Math.abs(milli % 1000)
    .toString()
    .padStart(3, '0')
  return `${whole}.${fraction}`
}

function toOutcome(
  localRefundUuid: string,
  row: {
    readonly submissionState: string
    readonly remoteUuid: string | null
    readonly refundNumber: string | null
    readonly lastErrorCode: string | null
  }
): RefundOutcome {
  return {
    localRefundUuid,
    state: row.submissionState as RefundOutcome['state'],
    remoteUuid: row.remoteUuid,
    refundNumber: row.refundNumber,
    errorCode: row.lastErrorCode
  }
}
