import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow
} from '@shared/contracts/sale.contract'
import type { SqliteDatabase } from '../database/connection'

export interface NewLocalInvoice {
  readonly localUuid: string
  readonly attemptKey: string
  readonly offlineNumber: string
  readonly companyUuid: string
  readonly branchUuid: string
  readonly warehouseUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly shiftUuid: string
  readonly commitSessionEpoch: number
  readonly catalogRevision: string
  readonly intentFingerprint: string
  readonly customerUuid: string | null
  readonly currency: string
  readonly currencyExponent: number
  readonly taxMode: LocalInvoiceRow['taxMode']
  readonly invoiceDiscountType: LocalInvoiceRow['invoiceDiscountType']
  readonly invoiceDiscountValue: number
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
  readonly paidTotalAmount: number
  readonly changeDueAmount: number
  readonly soldAt: string
  readonly connectivityStateAtSale: LocalInvoiceRow['connectivityStateAtSale']
  readonly soldWhileOffline: boolean
  readonly notes: string | null
  readonly commercialSnapshotJson: string
  readonly createdAt: string
}

export interface NewLocalInvoiceItem {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly lineIndex: number
  readonly productUuid: string
  readonly productName: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly unit: string | null
  readonly trackStock: boolean
  readonly quantityMilli: number
  readonly unitPriceAmount: number
  readonly currency: string
  readonly priceRevision: string
  readonly taxUuid: string | null
  readonly taxMode: LocalInvoiceItemRow['taxMode']
  readonly taxRateBasisPoints: number
  readonly taxRevision: string
  readonly discountType: LocalInvoiceItemRow['discountType']
  readonly discountValue: number
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
  readonly createdAt: string
}

export interface NewLocalInvoicePayment {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly paymentIndex: number
  readonly paymentMethodUuid: string
  readonly type: LocalInvoicePaymentRow['type']
  readonly amount: number
  readonly reference: string | null
  readonly requiresReference: boolean
  readonly paidAt: string
  readonly methodSnapshotJson: string
  readonly createdAt: string
}

function mapInvoiceRow(row: Record<string, unknown>): LocalInvoiceRow {
  return {
    localUuid: row.local_uuid as string,
    attemptKey: row.attempt_key as string,
    offlineNumber: row.offline_number as string,
    remoteUuid: row.remote_uuid as string | null,
    serverNumber: row.server_number as string | null,
    syncStatus: row.sync_status as LocalInvoiceRow['syncStatus'],
    syncAttempts: row.sync_attempts as number,
    lastSyncError: row.last_sync_error as string | null,
    syncedAt: row.synced_at as string | null,
    companyUuid: row.company_uuid as string,
    branchUuid: row.branch_uuid as string,
    warehouseUuid: row.warehouse_uuid as string,
    deviceUuid: row.device_uuid as string,
    userUuid: row.user_uuid as string,
    shiftUuid: row.shift_uuid as string,
    commitSessionEpoch: row.commit_session_epoch as number,
    catalogRevision: row.catalog_revision as string,
    intentFingerprint: row.intent_fingerprint as string,
    customerUuid: row.customer_uuid as string | null,
    currency: row.currency as string,
    currencyExponent: row.currency_exponent as number,
    taxMode: row.tax_mode as LocalInvoiceRow['taxMode'],
    invoiceDiscountType: row.invoice_discount_type as LocalInvoiceRow['invoiceDiscountType'],
    invoiceDiscountValue: row.invoice_discount_value as number,
    subtotalAmount: row.subtotal_amount as number,
    discountTotalAmount: row.discount_total_amount as number,
    taxTotalAmount: row.tax_total_amount as number,
    grandTotalAmount: row.grand_total_amount as number,
    paidTotalAmount: row.paid_total_amount as number,
    changeDueAmount: row.change_due_amount as number,
    dueAmount: row.due_amount as number,
    soldAt: row.sold_at as string,
    connectivityStateAtSale:
      row.connectivity_state_at_sale as LocalInvoiceRow['connectivityStateAtSale'],
    soldWhileOffline: Boolean(row.sold_while_offline),
    notes: row.notes as string | null,
    commercialSnapshotJson: row.commercial_snapshot_json as string,
    uploadPayloadVersion: row.upload_payload_version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function mapItemRow(row: Record<string, unknown>): LocalInvoiceItemRow {
  return {
    localUuid: row.local_uuid as string,
    invoiceLocalUuid: row.invoice_local_uuid as string,
    lineIndex: row.line_index as number,
    productUuid: row.product_uuid as string,
    productName: row.product_name as string,
    sku: row.sku as string | null,
    barcode: row.barcode as string | null,
    unit: row.unit as string | null,
    trackStock: Boolean(row.track_stock),
    quantityMilli: row.quantity_milli as number,
    unitPriceAmount: row.unit_price_amount as number,
    currency: row.currency as string,
    priceRevision: row.price_revision as string,
    taxUuid: row.tax_uuid as string | null,
    taxMode: row.tax_mode as LocalInvoiceItemRow['taxMode'],
    taxRateBasisPoints: row.tax_rate_basis_points as number,
    taxRevision: row.tax_revision as string,
    discountType: row.discount_type as LocalInvoiceItemRow['discountType'],
    discountValue: row.discount_value as number,
    subtotalAmount: row.subtotal_amount as number,
    discountAmount: row.discount_amount as number,
    taxAmount: row.tax_amount as number,
    totalAmount: row.total_amount as number,
    createdAt: row.created_at as string
  }
}

function mapPaymentRow(row: Record<string, unknown>): LocalInvoicePaymentRow {
  return {
    localUuid: row.local_uuid as string,
    invoiceLocalUuid: row.invoice_local_uuid as string,
    paymentIndex: row.payment_index as number,
    paymentMethodUuid: row.payment_method_uuid as string,
    type: row.type as LocalInvoicePaymentRow['type'],
    amount: row.amount as number,
    reference: row.reference as string | null,
    requiresReference: Boolean(row.requires_reference),
    paidAt: row.paid_at as string,
    methodSnapshotJson: row.method_snapshot_json as string,
    createdAt: row.created_at as string
  }
}

/**
 * CP-1 repository foundation only: typed writes/reads over `local_invoices`, `local_invoice_items`,
 * and `local_invoice_payments`. Callers own the surrounding business transaction; this repository
 * opens none of its own and enforces no cross-row invariant beyond what the schema's own CHECKs,
 * FKs, and unique constraints already enforce — the post-write reconciliation (§ post-write
 * invariants) is CP-2's `localSale.service.ts`.
 */
export class LocalSaleRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insertInvoice(invoice: NewLocalInvoice): LocalInvoiceRow {
    this.database
      .prepare(
        `INSERT INTO local_invoices (
           local_uuid, attempt_key, offline_number, sync_status, sync_attempts,
           company_uuid, branch_uuid, warehouse_uuid, device_uuid, user_uuid, shift_uuid,
           commit_session_epoch, catalog_revision, intent_fingerprint, customer_uuid,
           currency, currency_exponent, tax_mode, invoice_discount_type, invoice_discount_value,
           subtotal_amount, discount_total_amount, tax_total_amount, grand_total_amount,
           paid_total_amount, change_due_amount, due_amount, sold_at, connectivity_state_at_sale,
           sold_while_offline, notes, commercial_snapshot_json, upload_payload_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 2, ?, ?)`
      )
      .run(
        invoice.localUuid,
        invoice.attemptKey,
        invoice.offlineNumber,
        invoice.companyUuid,
        invoice.branchUuid,
        invoice.warehouseUuid,
        invoice.deviceUuid,
        invoice.userUuid,
        invoice.shiftUuid,
        invoice.commitSessionEpoch,
        invoice.catalogRevision,
        invoice.intentFingerprint,
        invoice.customerUuid,
        invoice.currency,
        invoice.currencyExponent,
        invoice.taxMode,
        invoice.invoiceDiscountType,
        invoice.invoiceDiscountValue,
        invoice.subtotalAmount,
        invoice.discountTotalAmount,
        invoice.taxTotalAmount,
        invoice.grandTotalAmount,
        invoice.paidTotalAmount,
        invoice.changeDueAmount,
        invoice.soldAt,
        invoice.connectivityStateAtSale,
        invoice.soldWhileOffline ? 1 : 0,
        invoice.notes,
        invoice.commercialSnapshotJson,
        invoice.createdAt,
        invoice.createdAt
      )

    const created = this.findInvoiceByLocalUuid(invoice.localUuid)

    if (!created) {
      throw new Error('Local invoice did not persist')
    }

    return created
  }

  insertItem(item: NewLocalInvoiceItem): LocalInvoiceItemRow {
    this.database
      .prepare(
        `INSERT INTO local_invoice_items (
           local_uuid, invoice_local_uuid, line_index, product_uuid, product_name, sku, barcode,
           unit, track_stock, quantity_milli, unit_price_amount, currency, price_revision,
           tax_uuid, tax_mode, tax_rate_basis_points, tax_revision, discount_type, discount_value,
           subtotal_amount, discount_amount, tax_amount, total_amount, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.localUuid,
        item.invoiceLocalUuid,
        item.lineIndex,
        item.productUuid,
        item.productName,
        item.sku,
        item.barcode,
        item.unit,
        item.trackStock ? 1 : 0,
        item.quantityMilli,
        item.unitPriceAmount,
        item.currency,
        item.priceRevision,
        item.taxUuid,
        item.taxMode,
        item.taxRateBasisPoints,
        item.taxRevision,
        item.discountType,
        item.discountValue,
        item.subtotalAmount,
        item.discountAmount,
        item.taxAmount,
        item.totalAmount,
        item.createdAt
      )

    const row = this.database
      .prepare('SELECT * FROM local_invoice_items WHERE local_uuid = ?')
      .get(item.localUuid) as Record<string, unknown> | undefined

    if (!row) {
      throw new Error('Local invoice item did not persist')
    }

    return mapItemRow(row)
  }

  insertPayment(payment: NewLocalInvoicePayment): LocalInvoicePaymentRow {
    this.database
      .prepare(
        `INSERT INTO local_invoice_payments (
           local_uuid, invoice_local_uuid, payment_index, payment_method_uuid, type, amount,
           reference, requires_reference, paid_at, method_snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payment.localUuid,
        payment.invoiceLocalUuid,
        payment.paymentIndex,
        payment.paymentMethodUuid,
        payment.type,
        payment.amount,
        payment.reference,
        payment.requiresReference ? 1 : 0,
        payment.paidAt,
        payment.methodSnapshotJson,
        payment.createdAt
      )

    const row = this.database
      .prepare('SELECT * FROM local_invoice_payments WHERE local_uuid = ?')
      .get(payment.localUuid) as Record<string, unknown> | undefined

    if (!row) {
      throw new Error('Local invoice payment did not persist')
    }

    return mapPaymentRow(row)
  }

  findInvoiceByLocalUuid(localUuid: string): LocalInvoiceRow | null {
    const row = this.database
      .prepare('SELECT * FROM local_invoices WHERE local_uuid = ?')
      .get(localUuid) as Record<string, unknown> | undefined

    return row ? mapInvoiceRow(row) : null
  }

  findInvoiceByAttemptKey(attemptKey: string): LocalInvoiceRow | null {
    const row = this.database
      .prepare('SELECT * FROM local_invoices WHERE attempt_key = ?')
      .get(attemptKey) as Record<string, unknown> | undefined

    return row ? mapInvoiceRow(row) : null
  }

  itemsForInvoice(invoiceLocalUuid: string): readonly LocalInvoiceItemRow[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM local_invoice_items WHERE invoice_local_uuid = ? ORDER BY line_index'
        )
        .all(invoiceLocalUuid) as Record<string, unknown>[]
    ).map(mapItemRow)
  }

  paymentsForInvoice(invoiceLocalUuid: string): readonly LocalInvoicePaymentRow[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM local_invoice_payments WHERE invoice_local_uuid = ? ORDER BY payment_index'
        )
        .all(invoiceLocalUuid) as Record<string, unknown>[]
    ).map(mapPaymentRow)
  }

  /**
   * D4-A: the next local/offline sequence number for one device-local calendar day, derived from
   * the highest existing suffix under the exact `POS-<prefix>-<datePart>-` offline_number prefix.
   * Safe under this app's single-writer, synchronous-transaction model (plan §1.7) — no separate
   * counter table is needed.
   */
  nextOfflineSequenceForDay(prefix: string, datePart: string): number {
    const likePattern = `POS-${prefix}-${datePart}-%`
    const row = this.database
      .prepare(
        `SELECT MAX(CAST(substr(offline_number, -6) AS INTEGER)) AS maxSequence
           FROM local_invoices WHERE offline_number LIKE ?`
      )
      .get(likePattern) as { maxSequence: number | null }

    return (row.maxSequence ?? 0) + 1
  }
}
