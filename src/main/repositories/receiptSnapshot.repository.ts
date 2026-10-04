import { createHash } from 'node:crypto'
import { canonicalJson, encodeTransactionReferenceQr } from '@shared/receipt/transactionQr'
import type { SqliteDatabase } from '../database/connection'

/**
 * Owner receipt copies — the sale's frozen receipt snapshot (v1) and its upload state (migration 0030).
 *
 * `captureForSale` runs INSIDE the sale-commit transaction, right after the receipt context row: it
 * freezes exactly that row, the receipt template version and the `txn-ref-v1` QR of the invoice row as
 * canonical JSON, with its sha256. The uploader later sends those exact bytes; nothing re-derives them.
 */

export const RECEIPT_SNAPSHOT_VERSION = 1
export const RECEIPT_SNAPSHOT_QR_TYPE = 'txn-ref-v1'

/**
 * Bounded, spaced retries for answers that may change (the sale not accepted yet, a server error):
 * after the n-th such answer the next try waits `RECEIPT_SNAPSHOT_RETRY_DELAYS_MS[n - 1]`, and the
 * upload is rejected as `retries_exhausted` after `RECEIPT_SNAPSHOT_MAX_ATTEMPTS`. A request that never
 * reached the server only moves `last_attempt_at` (spacing), never the count.
 */
export const RECEIPT_SNAPSHOT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000
]
export const RECEIPT_SNAPSHOT_MAX_ATTEMPTS = RECEIPT_SNAPSHOT_RETRY_DELAYS_MS.length + 1
/** A stored stamp more than a day ahead of the clock (a reset clock) is not trusted. */
const UNTRUSTED_FUTURE_MS = 24 * 3_600_000

export function isReceiptSnapshotUploadDue(
  attempts: number,
  lastAttemptAt: string | null,
  now: Date
): boolean {
  if (attempts >= RECEIPT_SNAPSHOT_MAX_ATTEMPTS) {
    return false
  }
  if (lastAttemptAt === null) {
    return true
  }
  const last = Date.parse(lastAttemptAt)
  const current = now.getTime()
  if (!Number.isFinite(last) || !Number.isFinite(current) || last - current > UNTRUSTED_FUTURE_MS) {
    return true
  }
  const delay = attempts === 0 ? 0 : RECEIPT_SNAPSHOT_RETRY_DELAYS_MS[attempts - 1]
  return current - last >= delay
}

interface ContextRow {
  readonly invoice_local_uuid: string
  readonly company_uuid: string
  readonly context_version: number
  readonly issuer_company_name: string
  readonly issuer_branch_name: string | null
  readonly issuer_warehouse_name: string | null
  readonly cashier_display_name: string | null
  readonly customer_name: string | null
  readonly customer_tax_number: string | null
  readonly time_zone: string
  readonly receipt_profile_version_uuid: string | null
  readonly created_at: string
}

interface InvoiceFacts {
  readonly sold_at: string
  readonly grand_total_amount: number
  readonly currency: string
  readonly currency_exponent: number
}

export interface StoredReceiptSnapshot {
  readonly invoiceLocalUuid: string
  readonly companyUuid: string
  readonly qrPayload: string
  readonly canonicalContent: string
  readonly contentSha256: string
}

export interface DueReceiptSnapshotUpload extends StoredReceiptSnapshot {
  readonly attempts: number
}

export type ReceiptSnapshotUploadState = 'pending' | 'accepted' | 'rejected'

export class ReceiptSnapshotRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /**
   * Freezes the snapshot of a sale whose receipt context was just written, in the caller's (sale-commit)
   * transaction. False when there is no context row (nothing honest to freeze), so no snapshot exists.
   */
  captureForSale(params: {
    readonly invoiceLocalUuid: string
    readonly templateVersion: number
    readonly createdAt: string
  }): boolean {
    if (!this.database.inTransaction) {
      throw new Error('A receipt snapshot is captured only inside the sale-commit transaction')
    }
    const context = this.database
      .prepare(
        `SELECT invoice_local_uuid, company_uuid, context_version, issuer_company_name,
                issuer_branch_name, issuer_warehouse_name, cashier_display_name, customer_name,
                customer_tax_number, time_zone, receipt_profile_version_uuid, created_at
         FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?`
      )
      .get(params.invoiceLocalUuid) as ContextRow | undefined
    const invoice = this.database
      .prepare(
        'SELECT sold_at, grand_total_amount, currency, currency_exponent FROM local_invoices WHERE local_uuid = ?'
      )
      .get(params.invoiceLocalUuid) as InvoiceFacts | undefined
    if (context === undefined || invoice === undefined) {
      return false
    }

    const qrPayload = encodeTransactionReferenceQr({
      companyUuid: context.company_uuid,
      documentKind: 'sale',
      documentUuid: context.invoice_local_uuid,
      instant: invoice.sold_at,
      totalMinor: invoice.grand_total_amount,
      currencyExponent: invoice.currency_exponent,
      currency: invoice.currency
    })
    const canonicalContent = canonicalJson({
      snapshot_version: RECEIPT_SNAPSHOT_VERSION,
      template_version: params.templateVersion,
      context: { ...context },
      qr: { type: RECEIPT_SNAPSHOT_QR_TYPE, payload: qrPayload }
    })
    const contentSha256 = createHash('sha256').update(canonicalContent, 'utf8').digest('hex')

    // A savepoint: both rows or neither, so a snapshot is never stored without its upload row.
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO local_invoice_receipt_snapshot (
             invoice_local_uuid, company_uuid, snapshot_version, qr_type, qr_payload,
             canonical_content, content_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.invoiceLocalUuid,
          context.company_uuid,
          RECEIPT_SNAPSHOT_VERSION,
          RECEIPT_SNAPSHOT_QR_TYPE,
          qrPayload,
          canonicalContent,
          contentSha256,
          params.createdAt
        )
      this.database
        .prepare(
          `INSERT INTO receipt_snapshot_uploads (invoice_local_uuid, state, updated_at)
           VALUES (?, 'pending', ?)`
        )
        .run(params.invoiceLocalUuid, params.createdAt)
    })()

    return true
  }

  find(invoiceLocalUuid: string): StoredReceiptSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT invoice_local_uuid AS invoiceLocalUuid, company_uuid AS companyUuid,
                qr_payload AS qrPayload, canonical_content AS canonicalContent,
                content_sha256 AS contentSha256
         FROM local_invoice_receipt_snapshot WHERE invoice_local_uuid = ?`
      )
      .get(invoiceLocalUuid) as StoredReceiptSnapshot | undefined
    return row ?? null
  }

  uploadState(
    invoiceLocalUuid: string
  ): { state: ReceiptSnapshotUploadState; attempts: number; lastErrorCode: string | null } | null {
    const row = this.database
      .prepare(
        `SELECT state, attempts, last_error_code AS lastErrorCode
         FROM receipt_snapshot_uploads WHERE invoice_local_uuid = ?`
      )
      .get(invoiceLocalUuid) as
      | { state: ReceiptSnapshotUploadState; attempts: number; lastErrorCode: string | null }
      | undefined
    return row ?? null
  }

  /**
   * Pending snapshots of the company's sales that the server has accepted (`sync_status = 'synced'`),
   * due at `now`, oldest sale first.
   */
  findDueUploads(
    companyUuid: string,
    now: Date,
    limit: number
  ): readonly DueReceiptSnapshotUpload[] {
    const rows = this.database
      .prepare(
        `SELECT s.invoice_local_uuid AS invoiceLocalUuid, s.company_uuid AS companyUuid,
                s.qr_payload AS qrPayload, s.canonical_content AS canonicalContent,
                s.content_sha256 AS contentSha256, u.attempts AS attempts,
                u.last_attempt_at AS lastAttemptAt
         FROM receipt_snapshot_uploads u
         JOIN local_invoice_receipt_snapshot s ON s.invoice_local_uuid = u.invoice_local_uuid
         JOIN local_invoices i ON i.local_uuid = u.invoice_local_uuid
         WHERE u.state = 'pending' AND s.company_uuid = ? AND i.sync_status = 'synced'
         ORDER BY i.sold_at, u.invoice_local_uuid`
      )
      .all(companyUuid) as (DueReceiptSnapshotUpload & { lastAttemptAt: string | null })[]

    return rows
      .filter((row) => isReceiptSnapshotUploadDue(row.attempts, row.lastAttemptAt, now))
      .slice(0, limit)
      .map((row) => ({
        invoiceLocalUuid: row.invoiceLocalUuid,
        companyUuid: row.companyUuid,
        qrPayload: row.qrPayload,
        canonicalContent: row.canonicalContent,
        contentSha256: row.contentSha256,
        attempts: row.attempts
      }))
  }

  markAccepted(invoiceLocalUuid: string, at: string): void {
    this.settle(invoiceLocalUuid, 'accepted', null, at)
  }

  markRejected(invoiceLocalUuid: string, code: string, at: string): void {
    this.settle(invoiceLocalUuid, 'rejected', code, at)
  }

  /**
   * A try that did not settle. `counted` (the server answered) moves the count, and the last allowed
   * one rejects the upload as `retries_exhausted`; an uncounted try (no answer) only spaces the next.
   */
  recordUnsettledAttempt(
    invoiceLocalUuid: string,
    code: string,
    counted: boolean,
    at: string
  ): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE receipt_snapshot_uploads
           SET attempts = attempts + ?, last_attempt_at = ?, last_error_code = ?, updated_at = ?
           WHERE invoice_local_uuid = ? AND state = 'pending'`
        )
        .run(counted ? 1 : 0, at, code, at, invoiceLocalUuid)
      const row = this.uploadState(invoiceLocalUuid)
      if (row?.state === 'pending' && row.attempts >= RECEIPT_SNAPSHOT_MAX_ATTEMPTS) {
        this.settle(invoiceLocalUuid, 'rejected', 'retries_exhausted', at)
      }
    })()
  }

  private settle(
    invoiceLocalUuid: string,
    state: 'accepted' | 'rejected',
    code: string | null,
    at: string
  ): void {
    this.database
      .prepare(
        `UPDATE receipt_snapshot_uploads
         SET state = ?, last_error_code = COALESCE(?, last_error_code), last_attempt_at = ?,
             settled_at = ?, updated_at = ?
         WHERE invoice_local_uuid = ? AND state = 'pending'`
      )
      .run(state, code, at, at, at, invoiceLocalUuid)
  }
}
