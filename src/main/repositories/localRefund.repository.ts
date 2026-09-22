import type {
  LocalRefundItemRow,
  LocalRefundPaymentRow,
  LocalRefundRow,
  RefundSubmissionState
} from '@shared/contracts/refund.contract'
import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'

export interface NewLocalRefund {
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
  readonly createdAt: string
}

export interface NewLocalRefundItem {
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
  readonly taxMode: LocalRefundItemRow['taxMode']
  readonly createdAt: string
}

export interface NewLocalRefundPayment {
  readonly localUuid: string
  readonly refundLocalUuid: string
  readonly paymentIndex: number
  readonly paymentMethodUuid: string | null
  readonly type: LocalRefundPaymentRow['type']
  readonly amount: number
  readonly reference: string | null
  readonly createdAt: string
}

function mapRefundRow(row: Record<string, unknown>): LocalRefundRow {
  return {
    localUuid: row.local_uuid as string,
    invoiceLocalUuid: row.invoice_local_uuid as string,
    invoiceRemoteUuid: row.invoice_remote_uuid as string,
    companyUuid: row.company_uuid as string,
    deviceUuid: row.device_uuid as string,
    userUuid: row.user_uuid as string,
    shiftUuid: row.shift_uuid as string,
    currency: row.currency as string,
    currencyExponent: row.currency_exponent as number,
    subtotalAmount: row.subtotal_amount as number,
    discountTotalAmount: row.discount_total_amount as number,
    taxTotalAmount: row.tax_total_amount as number,
    grandTotalAmount: row.grand_total_amount as number,
    refundedAt: row.refunded_at as string,
    stockReturned: Boolean(row.stock_returned),
    reason: row.reason as string | null,
    notes: row.notes as string | null,
    requestJson: row.request_json as string,
    requestSha256: row.request_sha256 as string,
    previewId: row.preview_id as string,
    dispatchCount: row.dispatch_count as number,
    submissionState: row.submission_state as RefundSubmissionState,
    remoteUuid: row.remote_uuid as string | null,
    refundNumber: row.refund_number as string | null,
    cancelledAt: row.cancelled_at as string | null,
    cancelledReason: row.cancelled_reason as string | null,
    lastErrorCode: row.last_error_code as string | null,
    lastErrorDetails: row.last_error_details as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function mapItemRow(row: Record<string, unknown>): LocalRefundItemRow {
  return {
    localUuid: row.local_uuid as string,
    refundLocalUuid: row.refund_local_uuid as string,
    lineIndex: row.line_index as number,
    invoiceItemRemoteUuid: row.invoice_item_remote_uuid as string,
    productUuid: row.product_uuid as string,
    productName: row.product_name as string,
    quantityMilli: row.quantity_milli as number,
    priorRefundedQuantityMilli: row.prior_refunded_quantity_milli as number,
    subtotalAmount: row.subtotal_amount as number,
    discountAmount: row.discount_amount as number,
    taxAmount: row.tax_amount as number,
    totalAmount: row.total_amount as number,
    taxMode: row.tax_mode as LocalRefundItemRow['taxMode'],
    createdAt: row.created_at as string
  }
}

function mapPaymentRow(row: Record<string, unknown>): LocalRefundPaymentRow {
  return {
    localUuid: row.local_uuid as string,
    refundLocalUuid: row.refund_local_uuid as string,
    paymentIndex: row.payment_index as number,
    paymentMethodUuid: row.payment_method_uuid as string | null,
    type: row.type as LocalRefundPaymentRow['type'],
    amount: row.amount as number,
    reference: row.reference as string | null,
    createdAt: row.created_at as string
  }
}

/**
 * Plan §3 (r5) — durable local refund identity: the frozen request, its state machine, and the
 * repository-level enforcement of the invariants the schema itself pins:
 *
 *  - at most one OPEN refund per invoice (`idx_local_refunds_one_open`, `conflict` included);
 *  - `request_json`/`request_sha256` are written once at `insert()` and never rewritten by any
 *    method here, including on cancellation;
 *  - `claimForDispatch`/`cancelIfPrepared` race through one conditional UPDATE, never through
 *    application-level locking alone (plan §3b).
 */
export class LocalRefundRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /**
   * Persists the frozen refund + its items + its payment in one transaction, in `prepared` state
   * with `dispatch_count = 0`. Nothing has been sent yet, so this is provably undispatched.
   */
  insert(
    refund: NewLocalRefund,
    items: readonly NewLocalRefundItem[],
    payments: readonly NewLocalRefundPayment[]
  ): LocalRefundRow {
    return runSerializedWrite(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO local_refunds (
             local_uuid, invoice_local_uuid, invoice_remote_uuid, company_uuid, device_uuid,
             user_uuid, shift_uuid, currency, currency_exponent, subtotal_amount,
             discount_total_amount, tax_total_amount, grand_total_amount, refunded_at,
             stock_returned, reason, notes, request_json, request_sha256, preview_id,
             dispatch_count, submission_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'prepared', ?, ?)`
        )
        .run(
          refund.localUuid,
          refund.invoiceLocalUuid,
          refund.invoiceRemoteUuid,
          refund.companyUuid,
          refund.deviceUuid,
          refund.userUuid,
          refund.shiftUuid,
          refund.currency,
          refund.currencyExponent,
          refund.subtotalAmount,
          refund.discountTotalAmount,
          refund.taxTotalAmount,
          refund.grandTotalAmount,
          refund.refundedAt,
          refund.stockReturned ? 1 : 0,
          refund.reason,
          refund.notes,
          refund.requestJson,
          refund.requestSha256,
          refund.previewId,
          refund.createdAt,
          refund.createdAt
        )

      items.forEach((item) => {
        this.database
          .prepare(
            `INSERT INTO local_refund_items (
               local_uuid, refund_local_uuid, line_index, invoice_item_remote_uuid, product_uuid,
               product_name, quantity_milli, prior_refunded_quantity_milli, subtotal_amount,
               discount_amount, tax_amount, total_amount, tax_mode, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            item.localUuid,
            item.refundLocalUuid,
            item.lineIndex,
            item.invoiceItemRemoteUuid,
            item.productUuid,
            item.productName,
            item.quantityMilli,
            item.priorRefundedQuantityMilli,
            item.subtotalAmount,
            item.discountAmount,
            item.taxAmount,
            item.totalAmount,
            item.taxMode,
            item.createdAt
          )
      })

      payments.forEach((payment) => {
        this.database
          .prepare(
            `INSERT INTO local_refund_payments (
               local_uuid, refund_local_uuid, payment_index, payment_method_uuid, type, amount,
               reference, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            payment.localUuid,
            payment.refundLocalUuid,
            payment.paymentIndex,
            payment.paymentMethodUuid,
            payment.type,
            payment.amount,
            payment.reference,
            payment.createdAt
          )
      })

      const created = this.findByLocalUuid(refund.localUuid)

      if (!created) {
        throw new Error('Local refund did not persist')
      }

      return created
    })
  }

  findByLocalUuid(localUuid: string): LocalRefundRow | null {
    const row = this.database
      .prepare('SELECT * FROM local_refunds WHERE local_uuid = ?')
      .get(localUuid) as Record<string, unknown> | undefined

    return row ? mapRefundRow(row) : null
  }

  /** Every refund (any state) recorded locally against this invoice, most recent first. */
  refundsForInvoice(invoiceLocalUuid: string): readonly LocalRefundRow[] {
    const rows = this.database
      .prepare('SELECT * FROM local_refunds WHERE invoice_local_uuid = ? ORDER BY created_at DESC')
      .all(invoiceLocalUuid) as Record<string, unknown>[]

    return rows.map(mapRefundRow)
  }

  /**
   * The one OPEN refund for this invoice, if any (`prepared`/`dispatched`/`unresolved`/`conflict`)
   * — mirrors the partial unique index exactly, including `conflict` inside the hold.
   */
  findOpenForInvoice(invoiceLocalUuid: string): LocalRefundRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM local_refunds
         WHERE invoice_local_uuid = ?
           AND submission_state IN ('prepared','dispatched','unresolved','conflict')`
      )
      .get(invoiceLocalUuid) as Record<string, unknown> | undefined

    return row ? mapRefundRow(row) : null
  }

  /** Every `unresolved` refund owned by this device -- crash-recovery resume candidates. */
  findUnresolved(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
  }): readonly LocalRefundRow[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM local_refunds
         WHERE company_uuid = ? AND device_uuid = ? AND submission_state = 'unresolved'
         ORDER BY created_at ASC`
      )
      .all(owner.companyUuid, owner.deviceUuid) as Record<string, unknown>[]

    return rows.map(mapRefundRow)
  }

  itemsForRefund(refundLocalUuid: string): readonly LocalRefundItemRow[] {
    const rows = this.database
      .prepare('SELECT * FROM local_refund_items WHERE refund_local_uuid = ? ORDER BY line_index')
      .all(refundLocalUuid) as Record<string, unknown>[]

    return rows.map(mapItemRow)
  }

  paymentsForRefund(refundLocalUuid: string): readonly LocalRefundPaymentRow[] {
    const rows = this.database
      .prepare(
        'SELECT * FROM local_refund_payments WHERE refund_local_uuid = ? ORDER BY payment_index'
      )
      .all(refundLocalUuid) as Record<string, unknown>[]

    return rows.map(mapPaymentRow)
  }

  /**
   * Claims the refund for dispatch: `prepared` -> `dispatched`, `dispatch_count += 1`, committed
   * **before** the HTTP call. This is what makes "the row shows dispatched" mean "at least one
   * request may have reached the server", independent of whether a response ever comes back.
   *
   * Also the resume path: `unresolved` -> `dispatched` re-dispatches the SAME frozen bytes.
   *
   * @returns false if the row was not in a dispatchable state (lost the cancel race, or already
   *   settled) -- the caller must not proceed to HTTP in that case.
   */
  claimForDispatch(localUuid: string, nowIso: string): boolean {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'dispatched', dispatch_count = dispatch_count + 1, updated_at = ?
         WHERE local_uuid = ? AND submission_state IN ('prepared','unresolved')`
      )
      .run(nowIso, localUuid) as { readonly changes: number }

    return updated.changes === 1
  }

  /**
   * `prepared` -> `cancelled`, but ONLY while `dispatch_count = 0` — races `claimForDispatch`
   * through this same conditional UPDATE, so exactly one of the two ever succeeds on a given row.
   * `request_json`/`request_sha256` are retained untouched.
   */
  cancelIfPrepared(localUuid: string, reason: string | null, nowIso: string): boolean {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'cancelled', cancelled_at = ?, cancelled_reason = ?, updated_at = ?
         WHERE local_uuid = ? AND submission_state = 'prepared' AND dispatch_count = 0`
      )
      .run(nowIso, reason, nowIso, localUuid) as { readonly changes: number }

    return updated.changes === 1
  }

  /**
   * Terminal: the server holds exactly one refund for this identity (a fresh 201, or a 200
   * duplicate replay). Both are `accepted` -- the distinction is not tracked locally because both
   * mean the same thing to the desktop.
   */
  markAccepted(
    localUuid: string,
    result: { readonly remoteUuid: string; readonly refundNumber: string | null },
    nowIso: string
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'accepted', remote_uuid = ?, refund_number = ?,
             last_error_code = NULL, last_error_details = NULL, updated_at = ?
         WHERE local_uuid = ?`
      )
      .run(result.remoteUuid, result.refundNumber, nowIso, localUuid) as {
      readonly changes: number
    }

    if (updated.changes !== 1) {
      throw new Error('Local refund was not found when recording acceptance')
    }
  }

  /**
   * Terminal AND blocking (definitive 422/409 business refusal — the refund did not happen, but
   * the identity is settled so it never blocks a NEW operation once observed).
   */
  markRejected(
    localUuid: string,
    errorCode: string | null,
    errorDetails: string | null,
    nowIso: string
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'rejected', last_error_code = ?, last_error_details = ?, updated_at = ?
         WHERE local_uuid = ?`
      )
      .run(errorCode, errorDetails, nowIso, localUuid) as { readonly changes: number }

    if (updated.changes !== 1) {
      throw new Error('Local refund was not found when recording a rejection')
    }
  }

  /**
   * Terminal but the outcome is UNKNOWN (409 idempotency conflict). Stays inside the "one open
   * refund" hold — plan §3a: an unknown outcome must keep blocking a replacement.
   */
  markConflict(
    localUuid: string,
    errorCode: string | null,
    errorDetails: string | null,
    nowIso: string
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'conflict', last_error_code = ?, last_error_details = ?, updated_at = ?
         WHERE local_uuid = ?`
      )
      .run(errorCode, errorDetails, nowIso, localUuid) as { readonly changes: number }

    if (updated.changes !== 1) {
      throw new Error('Local refund was not found when recording a conflict')
    }
  }

  /**
   * Non-terminal: timeout, connection loss, malformed/unrecognised success, unknown status, or
   * 401/403 (access revoked proves nothing about commit). Resumable via `claimForDispatch`.
   */
  markUnresolved(
    localUuid: string,
    errorCode: string | null,
    errorDetails: string | null,
    nowIso: string
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'unresolved', last_error_code = ?, last_error_details = ?, updated_at = ?
         WHERE local_uuid = ?`
      )
      .run(errorCode, errorDetails, nowIso, localUuid) as { readonly changes: number }

    if (updated.changes !== 1) {
      throw new Error('Local refund was not found when recording an unresolved outcome')
    }
  }

  /**
   * Startup crash recovery: every `dispatched` row becomes `unresolved` — conservative, because
   * dispatch is not disproved by a restart. `prepared` rows are provably undispatched and are left
   * alone (resumable as `prepared`, or cancellable).
   */
  sweepDispatchedToUnresolved(
    owner: { readonly companyUuid: string; readonly deviceUuid: string },
    nowIso: string
  ): number {
    const updated = this.database
      .prepare(
        `UPDATE local_refunds
         SET submission_state = 'unresolved', updated_at = ?
         WHERE company_uuid = ? AND device_uuid = ? AND submission_state = 'dispatched'`
      )
      .run(nowIso, owner.companyUuid, owner.deviceUuid) as { readonly changes: number }

    return updated.changes
  }
}
