import { createHash } from 'crypto'
import { encodeZatcaPhase1Qr, zatcaTimestamp } from '@shared/receipt/fiscalQr'
import { encodeTransactionReferenceQr } from '@shared/receipt/transactionQr'
import type {
  FiscalContextRepository,
  FiscalIdentityBlock,
  ReceiptQrType,
  SellerAddress
} from '../repositories/fiscalContext.repository'

/** The sale-commit refusal while a ZATCA register lacks a complete mirrored identity (non-terminal). */
export const FISCAL_SETUP_INCOMPLETE = 'fiscal-setup-incomplete'

const SAUDI_VAT = /^3\d{13}3$/

export interface ReceiptQr {
  readonly type: ReceiptQrType
  readonly payload: string
}

export interface SaleFiscalFacts {
  readonly invoiceLocalUuid: string
  readonly companyUuid: string
  readonly soldAt: string
  readonly grandTotalAmount: number
  readonly taxTotalAmount: number
  readonly currency: string
  readonly currencyExponent: number
}

export interface RefundFiscalFacts {
  readonly refundLocalUuid: string
  readonly companyUuid: string
  readonly refundedAt: string
  readonly grandTotalAmount: number
  readonly taxTotalAmount: number
  readonly currency: string
  readonly currencyExponent: number
}

/** The block the backend freezes at refund acceptance (`?fiscal_contract_version=1`). */
export interface ServerRefundFiscalBlock extends FiscalIdentityBlock {
  readonly issued_at: string
  readonly refund_number: string
  readonly original_invoice: { readonly number: string | null; readonly issued_at: string | null }
}

export type FiscalReadiness =
  | { readonly ok: true; readonly identity: FiscalIdentityBlock | null }
  | { readonly ok: false; readonly missing: readonly string[] }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function present(value: string | null | undefined): boolean {
  return (value ?? '').trim().length > 0
}

/** The fields a ZATCA identity is missing (empty when complete). */
export function missingZatcaFields(identity: {
  readonly seller_name: string | null
  readonly vat_number: string | null
  readonly seller_address: SellerAddress
}): string[] {
  const missing: string[] = []
  const name = (identity.seller_name ?? '').trim()
  if (name.length === 0 || new TextEncoder().encode(name).length > 255) missing.push('seller_name')
  if (!SAUDI_VAT.test(identity.vat_number ?? '')) missing.push('vat_number')
  if (!present(identity.seller_address.street)) missing.push('street')
  if (!present(identity.seller_address.city)) missing.push('city')
  if (!present(identity.seller_address.country)) missing.push('country')
  return missing
}

/**
 * POS improvements, Stage 6 — freezes each document's fiscal facts and QR, and recomputes the QR a
 * receipt is EXPECTED to carry (the pre-dispatch gate compares the rendered one against it).
 *
 * The QR type always follows the FROZEN regime: a ZATCA sale gets `zatca-p1`; a non-fiscal sale, and a
 * historical sale committed before contexts existed, get `txn-ref-v1` — never a fabricated VAT identity.
 */
export class FiscalContextService {
  constructor(
    private readonly repository: FiscalContextRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  readiness(companyUuid: string): FiscalReadiness {
    const identity = this.repository.identity(companyUuid)
    if (identity === null || identity.regime !== 'sa_zatca_phase1') {
      return { ok: true, identity }
    }
    const missing = missingZatcaFields(identity)
    return missing.length === 0 ? { ok: true, identity } : { ok: false, missing }
  }

  /** Inside the sale-commit transaction, after the invoice row. Throws if called while not ready. */
  captureForSale(facts: SaleFiscalFacts): ReceiptQr | null {
    if (!this.repository.available()) {
      return null
    }
    const readiness = this.readiness(facts.companyUuid)
    if (!readiness.ok) {
      throw new Error(`${FISCAL_SETUP_INCOMPLETE}: ${readiness.missing.join(',')}`)
    }
    const identity = readiness.identity
    const zatca = identity !== null && identity.regime === 'sa_zatca_phase1'
    const qr = zatca
      ? this.zatcaQr(
          identity.seller_name ?? '',
          identity.vat_number ?? '',
          facts.soldAt,
          facts.grandTotalAmount,
          facts.taxTotalAmount,
          facts.currencyExponent
        )
      : this.saleReference(facts)
    this.repository.insertInvoiceContext({
      invoiceLocalUuid: facts.invoiceLocalUuid,
      companyUuid: facts.companyUuid,
      regime: zatca ? 'sa_zatca_phase1' : 'none',
      sellerName: identity?.seller_name ?? null,
      vatNumber: identity?.vat_number ?? null,
      sellerAddress: identity?.seller_address ?? null,
      fiscalRevision: identity?.revision ?? null,
      qrType: qr.type,
      qrPayload: qr.payload,
      qrSha256: sha256(qr.payload),
      createdAt: this.now().toISOString()
    })
    return qr
  }

  /** When the refund is accepted, from the server's frozen block (or a reference when there is none). */
  captureForRefund(
    facts: RefundFiscalFacts,
    fiscal: ServerRefundFiscalBlock | null
  ): ReceiptQr | null {
    if (
      !this.repository.available() ||
      this.repository.refundContext(facts.refundLocalUuid) !== null
    ) {
      return null
    }
    const zatca = fiscal !== null && fiscal.regime === 'sa_zatca_phase1'
    const qr = zatca
      ? this.zatcaQr(
          fiscal.seller_name ?? '',
          fiscal.vat_number ?? '',
          fiscal.issued_at,
          facts.grandTotalAmount,
          facts.taxTotalAmount,
          facts.currencyExponent
        )
      : this.refundReference(facts)
    this.repository.insertRefundContext({
      refundLocalUuid: facts.refundLocalUuid,
      companyUuid: facts.companyUuid,
      regime: zatca ? 'sa_zatca_phase1' : 'none',
      fiscal: fiscal === null ? null : (fiscal as unknown as Record<string, unknown>),
      qrType: qr.type,
      qrPayload: qr.payload,
      qrSha256: sha256(qr.payload),
      createdAt: this.now().toISOString()
    })
    return qr
  }

  /**
   * The QR a sale receipt must carry, recomputed from FROZEN facts: the context's own identity and the
   * committed invoice totals; for a historical sale (no context), the reference over existing facts.
   * Returns `null` when the frozen context no longer reproduces its own stored payload.
   */
  expectedSaleQr(facts: SaleFiscalFacts): ReceiptQr | null {
    const context = this.repository.invoiceContext(facts.invoiceLocalUuid)
    if (context === null) {
      return this.saleReference(facts)
    }
    const recomputed =
      context.qrType === 'zatca-p1'
        ? this.zatcaQr(
            context.sellerName ?? '',
            context.vatNumber ?? '',
            facts.soldAt,
            facts.grandTotalAmount,
            facts.taxTotalAmount,
            facts.currencyExponent
          )
        : this.saleReference(facts)
    if (
      recomputed.payload !== context.qrPayload ||
      sha256(context.qrPayload) !== context.qrSha256
    ) {
      return null
    }
    return recomputed
  }

  expectedRefundQr(facts: RefundFiscalFacts): ReceiptQr | null {
    const context = this.repository.refundContext(facts.refundLocalUuid)
    if (context === null) {
      return this.refundReference(facts)
    }
    const fiscal = context.fiscal as ServerRefundFiscalBlock | null
    const recomputed =
      context.qrType === 'zatca-p1' && fiscal !== null
        ? this.zatcaQr(
            fiscal.seller_name ?? '',
            fiscal.vat_number ?? '',
            fiscal.issued_at,
            facts.grandTotalAmount,
            facts.taxTotalAmount,
            facts.currencyExponent
          )
        : this.refundReference(facts)
    if (
      recomputed.payload !== context.qrPayload ||
      sha256(context.qrPayload) !== context.qrSha256
    ) {
      return null
    }
    return recomputed
  }

  private zatcaQr(
    sellerName: string,
    vatNumber: string,
    instant: string,
    totalMinor: number,
    vatMinor: number,
    exponent: number
  ): ReceiptQr {
    const result = encodeZatcaPhase1Qr({
      sellerName: sellerName.trim(),
      vatNumber,
      timestamp: zatcaTimestamp(instant),
      totalMinor,
      vatMinor,
      currencyExponent: exponent
    })
    if (!result.ok) {
      throw new Error(`zatca-qr: ${result.reason}`)
    }
    return { type: 'zatca-p1', payload: result.payload }
  }

  private saleReference(facts: SaleFiscalFacts): ReceiptQr {
    return {
      type: 'txn-ref-v1',
      payload: encodeTransactionReferenceQr({
        companyUuid: facts.companyUuid,
        documentKind: 'sale',
        documentUuid: facts.invoiceLocalUuid,
        instant: facts.soldAt,
        totalMinor: facts.grandTotalAmount,
        currencyExponent: facts.currencyExponent,
        currency: facts.currency
      })
    }
  }

  private refundReference(facts: RefundFiscalFacts): ReceiptQr {
    return {
      type: 'txn-ref-v1',
      payload: encodeTransactionReferenceQr({
        companyUuid: facts.companyUuid,
        documentKind: 'refund',
        documentUuid: facts.refundLocalUuid,
        instant: facts.refundedAt,
        totalMinor: facts.grandTotalAmount,
        currencyExponent: facts.currencyExponent,
        currency: facts.currency
      })
    }
  }
}
