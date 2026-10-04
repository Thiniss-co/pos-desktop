import type { SqliteDatabase } from '../database/connection'

export type FiscalRegime = 'none' | 'sa_zatca_phase1'
export type ReceiptQrType = 'zatca-p1' | 'txn-ref-v1'

export interface SellerAddress {
  readonly street: string | null
  readonly city: string | null
  readonly postal_code: string | null
  readonly country: string | null
}

/** The negotiated bootstrap block, as the backend sends it. */
export interface FiscalIdentityBlock {
  readonly regime: FiscalRegime
  readonly seller_name: string | null
  readonly vat_number: string | null
  readonly seller_address: SellerAddress
  readonly revision: number
}

export interface InvoiceFiscalContextRow {
  readonly invoiceLocalUuid: string
  readonly companyUuid: string
  readonly regime: FiscalRegime
  readonly sellerName: string | null
  readonly vatNumber: string | null
  readonly sellerAddress: SellerAddress | null
  readonly fiscalRevision: number | null
  readonly qrType: ReceiptQrType
  readonly qrPayload: string
  readonly qrSha256: string
  readonly createdAt: string
}

export interface RefundFiscalContextRow {
  readonly refundLocalUuid: string
  readonly companyUuid: string
  readonly regime: FiscalRegime
  readonly fiscal: Record<string, unknown> | null
  readonly qrType: ReceiptQrType
  readonly qrPayload: string
  readonly qrSha256: string
  readonly createdAt: string
}

/** POS improvements, Stage 6: the fiscal identity mirror and the frozen fiscal contexts (0024). */
export class FiscalContextRepository {
  private tables: boolean | null = null

  constructor(private readonly database: SqliteDatabase) {}

  /** False on a pre-0024 schema (migration suites read through older schemas). */
  available(): boolean {
    if (this.tables === null) {
      this.tables =
        this.database
          .prepare(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('fiscal_identity', 'local_invoice_fiscal_context', 'local_refund_fiscal_context')"
          )
          .pluck()
          .get() === 3
    }
    return this.tables
  }

  /** Replaces (or, with `null`, removes) the company's mirrored identity. Caller owns the transaction. */
  replaceIdentity(companyUuid: string, block: FiscalIdentityBlock | null, now: string): void {
    if (!this.available()) {
      return
    }
    this.database.prepare('DELETE FROM fiscal_identity WHERE company_uuid = ?').run(companyUuid)
    if (block === null) {
      return
    }
    this.database
      .prepare(
        `INSERT INTO fiscal_identity
           (company_uuid, regime, seller_name, vat_number, street, city, postal_code, country, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        companyUuid,
        block.regime,
        block.seller_name,
        block.vat_number,
        block.seller_address.street,
        block.seller_address.city,
        block.seller_address.postal_code,
        block.seller_address.country,
        block.revision,
        now
      )
  }

  identity(companyUuid: string): FiscalIdentityBlock | null {
    if (!this.available()) {
      return null
    }
    const row = this.database
      .prepare('SELECT * FROM fiscal_identity WHERE company_uuid = ?')
      .get(companyUuid) as Record<string, unknown> | undefined
    if (!row) {
      return null
    }
    return {
      regime: row.regime as FiscalRegime,
      seller_name: (row.seller_name ?? null) as string | null,
      vat_number: (row.vat_number ?? null) as string | null,
      seller_address: {
        street: (row.street ?? null) as string | null,
        city: (row.city ?? null) as string | null,
        postal_code: (row.postal_code ?? null) as string | null,
        country: (row.country ?? null) as string | null
      },
      revision: row.revision as number
    }
  }

  insertInvoiceContext(row: InvoiceFiscalContextRow): void {
    this.database
      .prepare(
        `INSERT INTO local_invoice_fiscal_context
           (invoice_local_uuid, company_uuid, regime, seller_name, vat_number, seller_address_json,
            fiscal_revision, qr_type, qr_payload, qr_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.invoiceLocalUuid,
        row.companyUuid,
        row.regime,
        row.sellerName,
        row.vatNumber,
        row.sellerAddress === null ? null : JSON.stringify(row.sellerAddress),
        row.fiscalRevision,
        row.qrType,
        row.qrPayload,
        row.qrSha256,
        row.createdAt
      )
  }

  invoiceContext(invoiceLocalUuid: string): InvoiceFiscalContextRow | null {
    if (!this.available()) {
      return null
    }
    const row = this.database
      .prepare('SELECT * FROM local_invoice_fiscal_context WHERE invoice_local_uuid = ?')
      .get(invoiceLocalUuid) as Record<string, unknown> | undefined
    if (!row) {
      return null
    }
    return {
      invoiceLocalUuid: row.invoice_local_uuid as string,
      companyUuid: row.company_uuid as string,
      regime: row.regime as FiscalRegime,
      sellerName: (row.seller_name ?? null) as string | null,
      vatNumber: (row.vat_number ?? null) as string | null,
      sellerAddress:
        row.seller_address_json === null
          ? null
          : (JSON.parse(row.seller_address_json as string) as SellerAddress),
      fiscalRevision: (row.fiscal_revision ?? null) as number | null,
      qrType: row.qr_type as ReceiptQrType,
      qrPayload: row.qr_payload as string,
      qrSha256: row.qr_sha256 as string,
      createdAt: row.created_at as string
    }
  }

  insertRefundContext(row: RefundFiscalContextRow): void {
    this.database
      .prepare(
        `INSERT INTO local_refund_fiscal_context
           (refund_local_uuid, company_uuid, regime, fiscal_json, qr_type, qr_payload, qr_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.refundLocalUuid,
        row.companyUuid,
        row.regime,
        row.fiscal === null ? null : JSON.stringify(row.fiscal),
        row.qrType,
        row.qrPayload,
        row.qrSha256,
        row.createdAt
      )
  }

  refundContext(refundLocalUuid: string): RefundFiscalContextRow | null {
    if (!this.available()) {
      return null
    }
    const row = this.database
      .prepare('SELECT * FROM local_refund_fiscal_context WHERE refund_local_uuid = ?')
      .get(refundLocalUuid) as Record<string, unknown> | undefined
    if (!row) {
      return null
    }
    return {
      refundLocalUuid: row.refund_local_uuid as string,
      companyUuid: row.company_uuid as string,
      regime: row.regime as FiscalRegime,
      fiscal:
        row.fiscal_json === null
          ? null
          : (JSON.parse(row.fiscal_json as string) as Record<string, unknown>),
      qrType: row.qr_type as ReceiptQrType,
      qrPayload: row.qr_payload as string,
      qrSha256: row.qr_sha256 as string,
      createdAt: row.created_at as string
    }
  }
}
