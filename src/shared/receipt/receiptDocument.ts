/**
 * Receipt-printing plan §D-2/§D-9/§D-11 — the frozen, fully pre-formatted printable content model.
 * Built ONLY in main (`src/main/receipt/receiptDocument.service.ts`) from persisted rows; every
 * string here is already localized and formatted, so `receiptHtml.ts` only needs to escape and lay
 * it out -- it never formats a number, looks up a label, or makes a business decision.
 */

export type ReceiptLocale = 'en' | 'ar'

export interface ReceiptItemLine {
  readonly productName: string
  readonly sku: string | null
  readonly quantityText: string
  readonly unit: string | null
  readonly unitPriceText: string
  readonly lineTotalText: string
  readonly ownDiscountText: string | null
  readonly invoiceDiscountShareText: string | null
  readonly taxRateLabel: string | null
}

export interface ReceiptTaxLine {
  readonly rateLabel: string
  readonly amountText: string
}

export interface ReceiptPaymentLine {
  readonly label: string
  readonly amountText: string
  readonly maskedReference: string | null
}

export interface ReceiptDocument {
  readonly kind: 'sale' | 'refund' | 'test'
  readonly templateVersion: number
  readonly locale: ReceiptLocale
  readonly isReprint: boolean
  readonly header: {
    readonly companyName: string
    readonly branchName: string | null
    readonly addressLines: readonly string[]
    readonly phone: string | null
    readonly taxIdentifierLabel: string | null
    readonly taxIdentifierValue: string | null
    /**
     * Frozen at claim from the captured profile version (plan §D-5 "Hash C" / §D-11). Only the
     * sha256 and whether it was available to include — the bytes themselves are never part of
     * `document_json`; main resolves them separately, at render time, from the company-scoped
     * asset store.
     */
    readonly logo: { readonly sha256: string; readonly included: boolean } | null
  }
  readonly meta: {
    readonly receiptNumberLabel: string
    readonly receiptNumber: string
    readonly serverNumberLabel: string | null
    readonly serverNumber: string | null
    readonly dateTimeText: string
    readonly cashierLabel: string
    readonly cashierName: string | null
    readonly customerName: string | null
    readonly customerTaxNumber: string | null
    readonly currency: string
  }
  readonly items: readonly ReceiptItemLine[]
  readonly totals: {
    readonly subtotalText: string
    readonly itemDiscountText: string | null
    readonly invoiceDiscountText: string | null
    readonly taxLines: readonly ReceiptTaxLine[]
    readonly grandTotalText: string
    readonly payments: readonly ReceiptPaymentLine[]
    readonly paidText: string | null
    readonly changeText: string | null
  }
  readonly refund: {
    readonly refundNumber: string | null
    readonly refundDateText: string
    readonly originalOfflineNumber: string
    readonly originalServerNumber: string | null
    readonly stockReturned: boolean | null
    readonly reason: string | null
  } | null
  readonly notices: readonly string[]
  readonly footer: readonly string[]
}
