import type { SqliteDatabase } from '../database/connection'

/**
 * Receipt-printing plan §D-2/§D-8 — writes for the immutable receipt-context tables (migration
 * 0015). Every `insert*` here is called from INSIDE the existing sale-commit or refund-insert
 * transaction, so it commits or rolls back atomically with the business write it accompanies. The
 * tables' own triggers reject any UPDATE/DELETE, so this repository exposes no such methods.
 */

export interface NewInvoiceReceiptContext {
  readonly invoiceLocalUuid: string
  readonly companyUuid: string
  readonly issuerCompanyName: string
  readonly issuerBranchName: string | null
  readonly issuerWarehouseName: string | null
  readonly cashierDisplayName: string | null
  readonly customerName: string | null
  readonly customerTaxNumber: string | null
  readonly timeZone: string
  readonly receiptProfileVersionUuid: string | null
  readonly createdAt: string
}

export interface NewRefundReceiptContext {
  readonly refundLocalUuid: string
  readonly companyUuid: string
  readonly issuerCompanyName: string
  readonly issuerBranchName: string | null
  readonly cashierDisplayName: string | null
  readonly paymentMethodName: string | null
  readonly originalOfflineNumber: string
  readonly originalServerNumber: string | null
  readonly timeZone: string
  readonly receiptProfileVersionUuid: string | null
  readonly createdAt: string
}

export interface NewRefundLineReceiptContext {
  readonly refundItemLocalUuid: string
  readonly refundLocalUuid: string
  readonly invoiceItemRemoteUuid: string
  readonly originalUnitPriceAmount: number | null
  readonly originalQuantityMilli: number | null
  readonly unit: string | null
  readonly sku: string | null
  readonly taxRateText: string | null
  readonly createdAt: string
}

export class ReceiptContextRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insertInvoiceContext(row: NewInvoiceReceiptContext): void {
    this.database
      .prepare(
        `INSERT INTO local_invoice_receipt_context (
           invoice_local_uuid, company_uuid, context_version, issuer_company_name,
           issuer_branch_name, issuer_warehouse_name, cashier_display_name, customer_name,
           customer_tax_number, time_zone, receipt_profile_version_uuid, created_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.invoiceLocalUuid,
        row.companyUuid,
        row.issuerCompanyName,
        row.issuerBranchName,
        row.issuerWarehouseName,
        row.cashierDisplayName,
        row.customerName,
        row.customerTaxNumber,
        row.timeZone,
        row.receiptProfileVersionUuid,
        row.createdAt
      )
  }

  insertRefundContext(row: NewRefundReceiptContext): void {
    this.database
      .prepare(
        `INSERT INTO local_refund_receipt_context (
           refund_local_uuid, company_uuid, context_version, issuer_company_name,
           issuer_branch_name, cashier_display_name, payment_method_name,
           original_offline_number, original_server_number, time_zone,
           receipt_profile_version_uuid, created_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.refundLocalUuid,
        row.companyUuid,
        row.issuerCompanyName,
        row.issuerBranchName,
        row.cashierDisplayName,
        row.paymentMethodName,
        row.originalOfflineNumber,
        row.originalServerNumber,
        row.timeZone,
        row.receiptProfileVersionUuid,
        row.createdAt
      )
  }

  insertRefundLineContext(rows: readonly NewRefundLineReceiptContext[]): void {
    const statement = this.database.prepare(
      `INSERT INTO local_refund_line_receipt_context (
         refund_item_local_uuid, refund_local_uuid, invoice_item_remote_uuid,
         original_unit_price_amount, original_quantity_milli, unit, sku, tax_rate_text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const row of rows) {
      statement.run(
        row.refundItemLocalUuid,
        row.refundLocalUuid,
        row.invoiceItemRemoteUuid,
        row.originalUnitPriceAmount,
        row.originalQuantityMilli,
        row.unit,
        row.sku,
        row.taxRateText,
        row.createdAt
      )
    }
  }

  /** The company's current mirrored profile version, or null (D-11). Read inside the same
   *  transaction as the business write, so the captured version is exactly what was current at
   *  that commit instant. */
  getCurrentProfileVersionUuid(companyUuid: string): string | null {
    const row = this.database
      .prepare('SELECT version_uuid FROM receipt_profile_current WHERE company_uuid = ?')
      .get(companyUuid) as { version_uuid: string | null } | undefined

    return row?.version_uuid ?? null
  }

  findInvoiceContext(invoiceLocalUuid: string): NewInvoiceReceiptContext | null {
    const row = this.database
      .prepare(
        `SELECT invoice_local_uuid AS invoiceLocalUuid, company_uuid AS companyUuid,
                issuer_company_name AS issuerCompanyName, issuer_branch_name AS issuerBranchName,
                issuer_warehouse_name AS issuerWarehouseName,
                cashier_display_name AS cashierDisplayName, customer_name AS customerName,
                customer_tax_number AS customerTaxNumber, time_zone AS timeZone,
                receipt_profile_version_uuid AS receiptProfileVersionUuid, created_at AS createdAt
         FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?`
      )
      .get(invoiceLocalUuid) as NewInvoiceReceiptContext | undefined

    return row ?? null
  }

  findRefundContext(refundLocalUuid: string): NewRefundReceiptContext | null {
    const row = this.database
      .prepare(
        `SELECT refund_local_uuid AS refundLocalUuid, company_uuid AS companyUuid,
                issuer_company_name AS issuerCompanyName, issuer_branch_name AS issuerBranchName,
                cashier_display_name AS cashierDisplayName,
                payment_method_name AS paymentMethodName,
                original_offline_number AS originalOfflineNumber,
                original_server_number AS originalServerNumber, time_zone AS timeZone,
                receipt_profile_version_uuid AS receiptProfileVersionUuid, created_at AS createdAt
         FROM local_refund_receipt_context WHERE refund_local_uuid = ?`
      )
      .get(refundLocalUuid) as NewRefundReceiptContext | undefined

    return row ?? null
  }

  findRefundLineContexts(refundLocalUuid: string): readonly NewRefundLineReceiptContext[] {
    return this.database
      .prepare(
        `SELECT refund_item_local_uuid AS refundItemLocalUuid, refund_local_uuid AS refundLocalUuid,
                invoice_item_remote_uuid AS invoiceItemRemoteUuid,
                original_unit_price_amount AS originalUnitPriceAmount,
                original_quantity_milli AS originalQuantityMilli, unit, sku,
                tax_rate_text AS taxRateText, created_at AS createdAt
         FROM local_refund_line_receipt_context WHERE refund_local_uuid = ?`
      )
      .all(refundLocalUuid) as NewRefundLineReceiptContext[]
  }
}
