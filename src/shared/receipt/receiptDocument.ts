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

/**
 * POS improvements, Stage 6 — the fiscal part of a receipt, built from the document's FROZEN fiscal
 * context. The QR is mandatory on every sale and refund receipt; its type follows the frozen regime.
 */
export interface ReceiptFiscalBlock {
  readonly kind: 'zatca-sale' | 'zatca-credit-note' | 'receipt' | 'refund-receipt' | 'historical'
  readonly title: string
  /** Required ZATCA seller fields — always printed for a ZATCA document, whatever the branding. */
  readonly seller: {
    readonly name: string
    readonly vatLabel: string
    readonly vatNumber: string
    readonly addressLines: readonly string[]
  } | null
  /** Credit note: "This credit note relates to invoice number (N), issued on D". */
  readonly reference: string | null
  /** Historical copy: "Issued before fiscal data was recorded; this is not a tax invoice". */
  readonly historicalNote: string | null
  readonly qr: { readonly type: 'zatca-p1' | 'txn-ref-v1'; readonly payload: string }
  /** VAT breakdown keyed by (category, rate, mode). */
  readonly breakdown: ReadonlyArray<{
    readonly label: string
    readonly netText: string
    readonly taxText: string
  }>
  readonly netTotalLabel: string
  readonly netTotalText: string
  readonly vatTotalLabel: string
  readonly vatTotalText: string
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
    readonly logo: {
      readonly sha256: string
      readonly included: boolean
      /** Stage 6 (profile v2): absent on v1 versions (medium). */
      readonly size?: 'small' | 'medium' | 'large'
    } | null
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
  /** Stage 6 (template v2): absent on test receipts and on documents claimed before v2. */
  readonly fiscal?: ReceiptFiscalBlock | null
}
