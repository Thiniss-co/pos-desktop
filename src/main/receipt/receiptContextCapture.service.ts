import type {
  BootstrapBranch,
  BootstrapCompany,
  BootstrapWarehouse
} from '../repositories/bootstrapSnapshot.repository'
import type { ReceiptContextRepository } from '../repositories/receiptContext.repository'

/**
 * Receipt-printing plan §D-2 — resolves the issuer/cashier/customer names, the workstation time
 * zone, and the currently mirrored receipt-profile version, then writes the immutable context row
 * for a sale or a refund. Called from INSIDE the existing commit transaction, so its writes are
 * atomic with the business write. Every name is a point-in-time snapshot -- never re-resolved
 * later, and never re-read from "current" state after this call returns.
 */

export interface ReceiptContextCaptureDependencies {
  readonly receiptContext: Pick<
    ReceiptContextRepository,
    | 'insertInvoiceContext'
    | 'insertRefundContext'
    | 'insertRefundLineContext'
    | 'getCurrentProfileVersionUuid'
  >
  readonly bootstrapSnapshot: {
    getCompany(): BootstrapCompany | null
    getBranch(): BootstrapBranch | null
    getWarehouse(): BootstrapWarehouse | null
  }
  readonly sessionMetadata: { getSummary(): { readonly userName: string | null } }
  readonly customers: {
    findNameAndTaxNumber(customerUuid: string): { name: string; taxNumber: string | null } | null
  }
  readonly now?: () => Date
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export class ReceiptContextCaptureService {
  private readonly now: () => Date

  constructor(private readonly dependencies: ReceiptContextCaptureDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  captureForSale(params: {
    readonly invoiceLocalUuid: string
    readonly companyUuid: string
    readonly customerUuid: string | null
  }): void {
    const company = this.dependencies.bootstrapSnapshot.getCompany()

    // The company name is the one required fact (CHECK NOT NULL on the table): if bootstrap has
    // never captured a company row, there is nothing honest to snapshot, so no context row is
    // written at all -- the receipt then falls back to the labelled historical/current-name path
    // (plan §D-2), rather than writing a context row with a fabricated or empty company name.
    if (!company) {
      return
    }

    const branch = this.dependencies.bootstrapSnapshot.getBranch()
    const warehouse = this.dependencies.bootstrapSnapshot.getWarehouse()
    const cashierName = this.dependencies.sessionMetadata.getSummary().userName
    const customer = params.customerUuid
      ? this.dependencies.customers.findNameAndTaxNumber(params.customerUuid)
      : null

    this.dependencies.receiptContext.insertInvoiceContext({
      invoiceLocalUuid: params.invoiceLocalUuid,
      companyUuid: params.companyUuid,
      issuerCompanyName: company.name,
      issuerBranchName: branch?.name ?? null,
      issuerWarehouseName: warehouse?.name ?? null,
      cashierDisplayName: cashierName,
      customerName: customer?.name ?? null,
      customerTaxNumber: customer?.taxNumber ?? null,
      timeZone: resolveTimeZone(),
      receiptProfileVersionUuid: this.dependencies.receiptContext.getCurrentProfileVersionUuid(
        params.companyUuid
      ),
      createdAt: this.now().toISOString()
    })
  }

  captureForRefund(params: {
    readonly refundLocalUuid: string
    readonly companyUuid: string
    readonly paymentMethodName: string | null
    readonly originalOfflineNumber: string
    readonly originalServerNumber: string | null
    readonly lines: readonly {
      readonly refundItemLocalUuid: string
      readonly invoiceItemRemoteUuid: string
      readonly unitPriceAmount: number | null
      readonly quantityMilli: number | null
      readonly unit: string | null
      readonly sku: string | null
      readonly taxRateText: string | null
    }[]
  }): void {
    const company = this.dependencies.bootstrapSnapshot.getCompany()

    if (!company) {
      return
    }

    const branch = this.dependencies.bootstrapSnapshot.getBranch()
    const cashierName = this.dependencies.sessionMetadata.getSummary().userName
    const createdAt = this.now().toISOString()

    this.dependencies.receiptContext.insertRefundContext({
      refundLocalUuid: params.refundLocalUuid,
      companyUuid: params.companyUuid,
      issuerCompanyName: company.name,
      issuerBranchName: branch?.name ?? null,
      cashierDisplayName: cashierName,
      paymentMethodName: params.paymentMethodName,
      originalOfflineNumber: params.originalOfflineNumber,
      originalServerNumber: params.originalServerNumber,
      timeZone: resolveTimeZone(),
      receiptProfileVersionUuid: this.dependencies.receiptContext.getCurrentProfileVersionUuid(
        params.companyUuid
      ),
      createdAt
    })

    this.dependencies.receiptContext.insertRefundLineContext(
      params.lines.map((line) => ({
        refundItemLocalUuid: line.refundItemLocalUuid,
        refundLocalUuid: params.refundLocalUuid,
        invoiceItemRemoteUuid: line.invoiceItemRemoteUuid,
        originalUnitPriceAmount: line.unitPriceAmount,
        originalQuantityMilli: line.quantityMilli,
        unit: line.unit,
        sku: line.sku,
        taxRateText: line.taxRateText,
        createdAt
      }))
    )
  }
}
