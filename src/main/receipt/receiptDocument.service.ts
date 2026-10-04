import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type { LocalInvoiceItemRow } from '@shared/contracts/sale.contract'
import { calculateDiscount, formatQuantity } from '@shared/pos/posCalculator'
import { formatReceiptMoney } from '@shared/receipt/receiptMoney'
import { receiptStrings } from '@shared/receipt/receiptStrings'
import type {
  ReceiptDocument,
  ReceiptFiscalBlock,
  ReceiptItemLine,
  ReceiptLocale,
  ReceiptTaxLine
} from '@shared/receipt/receiptDocument'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { LocalRefundRepository } from '../repositories/localRefund.repository'
import type { ReceiptContextRepository } from '../repositories/receiptContext.repository'
import type { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import type { ReceiptProfileRepository } from '../repositories/receiptProfile.repository'
import type { FiscalContextRepository } from '../repositories/fiscalContext.repository'
import type { ServerRefundFiscalBlock } from './fiscalContext.service'
import { encodeTransactionReferenceQr } from '@shared/receipt/transactionQr'
import {
  ZATCA_CREDIT_NOTE_TITLE,
  ZATCA_SIMPLIFIED_INVOICE_TITLE
} from '@shared/receipt/receiptStrings'

/**
 * Receipt-printing plan §D-2/§D-9 — builds the frozen, printable `ReceiptDocument` from persisted
 * rows ONLY. This dependency type has no API client: printing an offline sale never makes a
 * network call. Every value is derived from stored snapshot columns; nothing here reads current
 * catalog prices, current tax settings or current `track_stock`.
 */

/** 2 (POS improvements, Stage 6): fiscal block, mandatory QR, VAT breakdown. */
export const RECEIPT_TEMPLATE_VERSION = 2

export interface ReceiptDocumentDependencies {
  readonly localSale: Pick<
    LocalSaleRepository,
    'findInvoiceByLocalUuid' | 'itemsForInvoice' | 'paymentsForInvoice'
  >
  readonly localRefunds: Pick<
    LocalRefundRepository,
    'findByLocalUuid' | 'itemsForRefund' | 'paymentsForRefund'
  >
  readonly receiptContext: Pick<
    ReceiptContextRepository,
    'findInvoiceContext' | 'findRefundContext' | 'findRefundLineContexts'
  >
  readonly bootstrapSnapshot: Pick<BootstrapSnapshotRepository, 'getCompany' | 'getBranch'>
  /** Optional: absent only in a handful of narrow unit-test fakes that do not exercise branding.
   *  Production wiring always supplies it (plan §D-11 — rendering reads branding ONLY from the
   *  captured profile version, never from the current mirror pointer). */
  readonly receiptProfile?: Pick<ReceiptProfileRepository, 'getVersion' | 'getCurrent'>
  /** POS improvements, Stage 6: the frozen fiscal contexts (absent only in narrow unit fakes). */
  readonly fiscalContexts?: Pick<FiscalContextRepository, 'invoiceContext' | 'refundContext'>
}

function notFound(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'This receipt could not be found.',
    backendCode: 'receipt_not_found',
    retryable: false
  })
}

/**
 * POS improvements, Stage 6: the offset of the receipt's FROZEN time zone at that instant (Intl
 * `longOffset`), not the workstation's — the earlier approximation printed the workstation offset.
 */
function zoneOffset(date: Date, timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value
    const match = name === undefined ? null : /^GMT(?:([+-]\d{2}):(\d{2}))?$/.exec(name)
    if (match) {
      return match[1] ? `UTC${match[1]}:${match[2]}` : 'UTC+00:00'
    }
  } catch {
    // fall through to the workstation offset below
  }
  return formatOffset(date)
}

function formatOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `UTC${sign}${hh}:${mm}`
}

function formatDateTime(isoUtc: string, timeZone: string, locale: ReceiptLocale): string {
  try {
    const date = new Date(isoUtc)
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      numberingSystem: 'latn'
    }).format(date)
    return `${formatted} (${zoneOffset(date, timeZone)})`
  } catch {
    return isoUtc
  }
}

function paymentLabel(
  strings: ReturnType<typeof receiptStrings>,
  snapshotName: string | null,
  type: 'cash' | 'card' | 'other'
): string {
  if (snapshotName) {
    return snapshotName
  }

  if (type === 'cash') return strings.cashLabel
  if (type === 'card') return strings.cardLabel
  if (type === 'other') return strings.otherPaymentLabel
  return strings.paymentNotRecordedLabel
}

function maskReference(reference: string | null): string | null {
  if (!reference) {
    return null
  }
  if (reference.length <= 4) {
    return reference
  }
  return `••••${reference.slice(-4)}`
}

function parsePaymentSnapshotName(methodSnapshotJson: string): string | null {
  try {
    const parsed = JSON.parse(methodSnapshotJson) as { name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

function formatDate(isoUtc: string, timeZone: string, locale: ReceiptLocale): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      numberingSystem: 'latn'
    }).format(new Date(isoUtc))
  } catch {
    return isoUtc.slice(0, 10)
  }
}

interface BreakdownLine {
  readonly category: 'standard' | 'zero_rated' | 'exempt' | null
  readonly rateBasisPoints: number
  readonly mode: 'none' | 'inclusive' | 'exclusive'
  readonly taxAmount: number
  readonly totalAmount: number
}

/** Stage 6: the VAT breakdown keyed by (category, rate, mode): net = total − tax for every mode. */
function vatBreakdown(
  lines: readonly BreakdownLine[],
  strings: ReturnType<typeof receiptStrings>,
  money: (amount: number) => string
): ReceiptFiscalBlock['breakdown'] {
  const groups = new Map<string, { line: BreakdownLine; net: number; tax: number }>()
  for (const line of lines) {
    const key = `${line.category ?? '-'}|${line.rateBasisPoints}|${line.mode}`
    const group = groups.get(key) ?? { line, net: 0, tax: 0 }
    group.net += line.totalAmount - line.taxAmount
    group.tax += line.taxAmount
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.line.rateBasisPoints - a.line.rateBasisPoints || a.line.mode.localeCompare(b.line.mode)
    )
    .map(({ line, net, tax }) => ({
      label:
        line.mode === 'none'
          ? strings.modeLabel('none')
          : `${strings.categoryLabel(line.category)} ${line.rateBasisPoints / 100}% · ${strings.modeLabel(line.mode)}`,
      netText: money(net),
      taxText: money(tax)
    }))
}

function addressLines(address: {
  readonly street: string | null
  readonly city: string | null
  readonly postal_code: string | null
  readonly country: string | null
}): string[] {
  return [
    address.street,
    [address.city, address.postal_code].filter((part) => (part ?? '').trim() !== '').join(' '),
    address.country
  ].filter((line): line is string => (line ?? '').trim() !== '')
}

export class ReceiptDocumentService {
  constructor(private readonly dependencies: ReceiptDocumentDependencies) {}

  buildSaleDocument(
    invoiceLocalUuid: string,
    locale: ReceiptLocale,
    isReprint: boolean
  ): ReceiptDocument {
    const invoice = this.dependencies.localSale.findInvoiceByLocalUuid(invoiceLocalUuid)

    if (!invoice) {
      throw notFound()
    }

    const items = this.dependencies.localSale.itemsForInvoice(invoiceLocalUuid)
    const payments = this.dependencies.localSale.paymentsForInvoice(invoiceLocalUuid)
    const context = this.dependencies.receiptContext.findInvoiceContext(invoiceLocalUuid)
    const strings = receiptStrings(locale)
    const money = (amount: number): string =>
      formatReceiptMoney(amount, locale, invoice.currency, invoice.currencyExponent)

    const names = this.resolveIssuerNames(
      context?.issuerCompanyName ?? null,
      context?.issuerBranchName ?? null
    )
    const branding = this.resolveBranding(
      invoice.companyUuid,
      context?.receiptProfileVersionUuid ?? null
    )
    const header = {
      ...names,
      ...branding.header,
      branchName: branding.display.showBranch ? names.branchName : null
    }

    const itemLines: ReceiptItemLine[] = items
      .slice()
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((item) => this.buildSaleItemLine(item, locale, strings, money))

    const taxLines = this.groupTaxByRate(items, money)
    const itemDiscountTotal = items.reduce((sum, item) => sum + this.ownDiscount(item), 0)
    const invoiceDiscountShare = Math.max(0, invoice.discountTotalAmount - itemDiscountTotal)

    const paymentLines = payments
      .slice()
      .sort((a, b) => a.paymentIndex - b.paymentIndex)
      .map((payment) => ({
        label: paymentLabel(
          strings,
          parsePaymentSnapshotName(payment.methodSnapshotJson),
          payment.type
        ),
        amountText: money(payment.amount),
        maskedReference: maskReference(payment.reference)
      }))

    const notices: string[] = []
    if (invoice.syncStatus !== 'synced') {
      notices.push(strings.unsyncedNotice)
    }
    if (!context) {
      notices.push(strings.historicalNotice)
    }

    return {
      kind: 'sale',
      templateVersion: RECEIPT_TEMPLATE_VERSION,
      locale,
      isReprint,
      header,
      meta: {
        receiptNumberLabel: strings.receiptNumberLabel,
        receiptNumber: invoice.offlineNumber,
        serverNumberLabel: invoice.serverNumber ? strings.serverNumberLabel : null,
        serverNumber: invoice.serverNumber,
        dateTimeText: formatDateTime(invoice.soldAt, context?.timeZone ?? 'UTC', locale),
        cashierLabel: strings.cashierLabel,
        cashierName: branding.display.showCashier ? (context?.cashierDisplayName ?? null) : null,
        customerName: branding.display.showCustomer ? (context?.customerName ?? null) : null,
        customerTaxNumber: context?.customerTaxNumber ?? null,
        currency: invoice.currency
      },
      items: itemLines,
      totals: {
        subtotalText: money(invoice.subtotalAmount),
        itemDiscountText: itemDiscountTotal > 0 ? money(itemDiscountTotal) : null,
        invoiceDiscountText: invoiceDiscountShare > 0 ? money(invoiceDiscountShare) : null,
        taxLines,
        grandTotalText: money(invoice.grandTotalAmount),
        payments: paymentLines,
        paidText:
          invoice.changeDueAmount > 0 || payments.length > 1
            ? money(invoice.paidTotalAmount)
            : null,
        changeText: invoice.changeDueAmount > 0 ? money(invoice.changeDueAmount) : null
      },
      refund: null,
      notices,
      footer: branding.footerLines,
      fiscal: this.saleFiscal(invoice, items, strings, money)
    }
  }

  buildRefundDocument(
    refundLocalUuid: string,
    locale: ReceiptLocale,
    isReprint: boolean
  ): ReceiptDocument {
    const refund = this.dependencies.localRefunds.findByLocalUuid(refundLocalUuid)

    if (!refund) {
      throw notFound()
    }

    const items = this.dependencies.localRefunds.itemsForRefund(refundLocalUuid)
    const payments = this.dependencies.localRefunds.paymentsForRefund(refundLocalUuid)
    const context = this.dependencies.receiptContext.findRefundContext(refundLocalUuid)
    const lineContexts = this.dependencies.receiptContext.findRefundLineContexts(refundLocalUuid)
    const lineContextByItemUuid = new Map(
      lineContexts.map((line) => [line.invoiceItemRemoteUuid, line])
    )
    const strings = receiptStrings(locale)
    const money = (amount: number): string =>
      formatReceiptMoney(amount, locale, refund.currency, refund.currencyExponent)

    const names = this.resolveIssuerNames(
      context?.issuerCompanyName ?? null,
      context?.issuerBranchName ?? null
    )
    const branding = this.resolveBranding(
      refund.companyUuid,
      context?.receiptProfileVersionUuid ?? null
    )
    const header = {
      ...names,
      ...branding.header,
      branchName: branding.display.showBranch ? names.branchName : null
    }

    const itemLines: ReceiptItemLine[] = items
      .slice()
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((item) => {
        const descriptor = lineContextByItemUuid.get(item.invoiceItemRemoteUuid) ?? null
        return {
          productName: item.productName,
          sku: descriptor?.sku ?? null,
          quantityText: this.quantityText(item.quantityMilli),
          unit: descriptor?.unit ?? null,
          unitPriceText:
            descriptor?.originalUnitPriceAmount != null
              ? money(descriptor.originalUnitPriceAmount)
              : '',
          lineTotalText: money(item.totalAmount),
          ownDiscountText: item.discountAmount > 0 ? money(item.discountAmount) : null,
          invoiceDiscountShareText: null,
          // The server's decimal rate text ("15.0000") prints like a sale line ("15%").
          taxRateLabel: descriptor?.taxRateText ? `${Number(descriptor.taxRateText)}%` : null
        }
      })

    const taxTotal = items.reduce((sum, item) => sum + item.taxAmount, 0)
    const taxLines: ReceiptTaxLine[] =
      taxTotal > 0 ? [{ rateLabel: strings.taxLabel, amountText: money(taxTotal) }] : []

    const paymentLines = payments
      .slice()
      .sort((a, b) => a.paymentIndex - b.paymentIndex)
      .map((payment) => ({
        label: paymentLabel(strings, context?.paymentMethodName ?? null, payment.type),
        amountText: money(payment.amount),
        maskedReference: maskReference(payment.reference)
      }))

    const notices: string[] = []
    if (!context) {
      notices.push(strings.historicalNotice)
    }
    if (lineContexts.length === 0) {
      notices.push(strings.originalPriceNotRecordedNotice)
    }

    return {
      kind: 'refund',
      templateVersion: RECEIPT_TEMPLATE_VERSION,
      locale,
      isReprint,
      header,
      meta: {
        receiptNumberLabel: strings.refundNumberLabel,
        receiptNumber: refund.refundNumber ?? refund.localUuid,
        serverNumberLabel: null,
        serverNumber: null,
        dateTimeText: formatDateTime(refund.refundedAt, context?.timeZone ?? 'UTC', locale),
        cashierLabel: strings.cashierLabel,
        cashierName: branding.display.showCashier ? (context?.cashierDisplayName ?? null) : null,
        customerName: null,
        customerTaxNumber: null,
        currency: refund.currency
      },
      items: itemLines,
      totals: {
        subtotalText: money(refund.subtotalAmount),
        itemDiscountText: refund.discountTotalAmount > 0 ? money(refund.discountTotalAmount) : null,
        invoiceDiscountText: null,
        taxLines,
        grandTotalText: money(refund.grandTotalAmount),
        payments: paymentLines,
        paidText: null,
        changeText: null
      },
      refund: {
        refundNumber: refund.refundNumber,
        refundDateText: formatDateTime(refund.refundedAt, context?.timeZone ?? 'UTC', locale),
        originalOfflineNumber: context?.originalOfflineNumber ?? refund.invoiceLocalUuid,
        originalServerNumber: context?.originalServerNumber ?? null,
        stockReturned: refund.stockReturned,
        reason: refund.reason
      },
      notices,
      footer: branding.footerLines,
      fiscal: this.refundFiscal(
        refund,
        items,
        lineContexts,
        strings,
        money,
        context?.timeZone ?? 'UTC',
        locale
      )
    }
  }

  /**
   * POS improvements, Stage 6: the sale's fiscal block from its FROZEN context. A sale committed before
   * contexts existed is a historical copy with a reference QR over existing facts — never a VAT identity
   * taken from today's settings.
   */
  private saleFiscal(
    invoice: NonNullable<ReturnType<LocalSaleRepository['findInvoiceByLocalUuid']>>,
    items: readonly LocalInvoiceItemRow[],
    strings: ReturnType<typeof receiptStrings>,
    money: (amount: number) => string
  ): ReceiptFiscalBlock {
    const context = this.dependencies.fiscalContexts?.invoiceContext(invoice.localUuid) ?? null
    const zatca = context !== null && context.regime === 'sa_zatca_phase1'
    const breakdown = vatBreakdown(
      items.map((item) => ({
        category: item.taxCategory ?? null,
        rateBasisPoints: item.taxRateBasisPoints,
        mode: item.taxMode,
        taxAmount: item.taxAmount,
        totalAmount: item.totalAmount
      })),
      strings,
      money
    )
    const qr =
      context !== null
        ? { type: context.qrType, payload: context.qrPayload }
        : {
            type: 'txn-ref-v1' as const,
            payload: encodeTransactionReferenceQr({
              companyUuid: invoice.companyUuid,
              documentKind: 'sale',
              documentUuid: invoice.localUuid,
              instant: invoice.soldAt,
              totalMinor: invoice.grandTotalAmount,
              currencyExponent: invoice.currencyExponent,
              currency: invoice.currency
            })
          }
    return {
      kind: zatca ? 'zatca-sale' : context !== null ? 'receipt' : 'historical',
      title: zatca
        ? ZATCA_SIMPLIFIED_INVOICE_TITLE
        : context !== null
          ? strings.receiptTitle
          : strings.historicalTitle,
      seller:
        zatca && context.sellerName !== null && context.vatNumber !== null
          ? {
              name: context.sellerName,
              vatLabel: strings.vatNumberLabel,
              vatNumber: context.vatNumber,
              addressLines:
                context.sellerAddress === null ? [] : addressLines(context.sellerAddress)
            }
          : null,
      reference: null,
      historicalNote: context === null ? strings.historicalNote : null,
      qr,
      breakdown,
      netTotalLabel: strings.totalExclVatLabel,
      netTotalText: money(invoice.grandTotalAmount - invoice.taxTotalAmount),
      vatTotalLabel: strings.vatTotalLabel,
      vatTotalText: money(invoice.taxTotalAmount)
    }
  }

  /**
   * Stage 6: the accepted refund's fiscal block. A ZATCA refund is a credit note carrying the seller
   * identity, note number and original-invoice reference the SERVER froze at acceptance.
   */
  private refundFiscal(
    refund: NonNullable<ReturnType<LocalRefundRepository['findByLocalUuid']>>,
    items: ReturnType<LocalRefundRepository['itemsForRefund']>,
    lineContexts: ReturnType<ReceiptContextRepository['findRefundLineContexts']>,
    strings: ReturnType<typeof receiptStrings>,
    money: (amount: number) => string,
    timeZone: string,
    locale: ReceiptLocale
  ): ReceiptFiscalBlock {
    const context = this.dependencies.fiscalContexts?.refundContext(refund.localUuid) ?? null
    const fiscal = (context?.fiscal ?? null) as ServerRefundFiscalBlock | null
    const zatca = context !== null && context.regime === 'sa_zatca_phase1' && fiscal !== null
    // Categories come from the ORIGINAL invoice lines (by product), which froze them at commit.
    const originalItems = this.dependencies.localSale.itemsForInvoice(refund.invoiceLocalUuid)
    const categoryByProduct = new Map(
      originalItems.map((item) => [item.productUuid, item.taxCategory ?? null])
    )
    const rateByProduct = new Map(
      originalItems.map((item) => [item.productUuid, item.taxRateBasisPoints])
    )
    const descriptorRate = new Map(
      lineContexts.map((line) => [
        line.invoiceItemRemoteUuid,
        line.taxRateText ? Math.round(Number(line.taxRateText) * 100) : null
      ])
    )
    const breakdown = vatBreakdown(
      items.map((item) => ({
        category: categoryByProduct.get(item.productUuid) ?? null,
        rateBasisPoints:
          descriptorRate.get(item.invoiceItemRemoteUuid) ??
          rateByProduct.get(item.productUuid) ??
          0,
        mode: item.taxMode,
        taxAmount: item.taxAmount,
        totalAmount: item.totalAmount
      })),
      strings,
      money
    )
    const qr =
      context !== null
        ? { type: context.qrType, payload: context.qrPayload }
        : {
            type: 'txn-ref-v1' as const,
            payload: encodeTransactionReferenceQr({
              companyUuid: refund.companyUuid,
              documentKind: 'refund',
              documentUuid: refund.localUuid,
              instant: refund.refundedAt,
              totalMinor: refund.grandTotalAmount,
              currencyExponent: refund.currencyExponent,
              currency: refund.currency
            })
          }
    return {
      kind: zatca ? 'zatca-credit-note' : context !== null ? 'refund-receipt' : 'historical',
      title: zatca
        ? ZATCA_CREDIT_NOTE_TITLE
        : context !== null
          ? strings.refundReceiptTitle
          : strings.historicalTitle,
      seller:
        zatca && fiscal.seller_name !== null && fiscal.vat_number !== null
          ? {
              name: fiscal.seller_name,
              vatLabel: strings.vatNumberLabel,
              vatNumber: fiscal.vat_number,
              addressLines: addressLines(fiscal.seller_address)
            }
          : null,
      reference:
        zatca && fiscal.original_invoice.number !== null
          ? strings.creditNoteReference(
              fiscal.original_invoice.number,
              fiscal.original_invoice.issued_at === null
                ? '—'
                : formatDate(fiscal.original_invoice.issued_at, timeZone, locale)
            )
          : null,
      historicalNote: context === null ? strings.historicalNote : null,
      qr,
      breakdown,
      netTotalLabel: strings.totalExclVatLabel,
      netTotalText: money(refund.grandTotalAmount - refund.taxTotalAmount),
      vatTotalLabel: strings.vatTotalLabel,
      vatTotalText: money(refund.taxTotalAmount)
    }
  }

  /** Test receipts use the CALLER's current mirrored profile (plan §D-11) — there is no captured
   *  version to freeze from, since a test print never commits a sale or refund. `companyUuid` is
   *  optional only for the handful of narrow unit tests that do not exercise branding. */
  buildTestDocument(locale: ReceiptLocale, companyUuid: string | null = null): ReceiptDocument {
    const strings = receiptStrings(locale)
    const names = this.resolveIssuerNames(null, null)
    const currentVersionUuid =
      companyUuid && this.dependencies.receiptProfile
        ? (this.dependencies.receiptProfile.getCurrent(companyUuid)?.versionUuid ?? null)
        : null
    const branding = this.resolveBranding(companyUuid, currentVersionUuid)
    const header = {
      ...names,
      ...branding.header,
      branchName: branding.display.showBranch ? names.branchName : null
    }
    const money = (amount: number): string => formatReceiptMoney(amount, locale, 'USD', 2)

    return {
      kind: 'test',
      templateVersion: RECEIPT_TEMPLATE_VERSION,
      locale,
      isReprint: false,
      header,
      meta: {
        receiptNumberLabel: strings.receiptNumberLabel,
        receiptNumber: 'TEST-0000',
        serverNumberLabel: null,
        serverNumber: null,
        dateTimeText: strings.testTitle,
        cashierLabel: strings.cashierLabel,
        cashierName: 'Test Cashier',
        customerName: null,
        customerTaxNumber: null,
        currency: 'USD'
      },
      items: [
        {
          productName: 'Sample Product',
          sku: 'TEST-SKU',
          quantityText: '1',
          unit: 'pc',
          unitPriceText: money(1000),
          lineTotalText: money(1000),
          ownDiscountText: null,
          invoiceDiscountShareText: null,
          taxRateLabel: null
        }
      ],
      totals: {
        subtotalText: money(1000),
        itemDiscountText: null,
        invoiceDiscountText: null,
        taxLines: [],
        grandTotalText: money(1000),
        payments: [{ label: strings.cashLabel, amountText: money(1000), maskedReference: null }],
        paidText: null,
        changeText: null
      },
      refund: null,
      notices: [],
      footer: branding.footerLines
    }
  }

  private resolveIssuerNames(
    frozenCompanyName: string | null,
    frozenBranchName: string | null
  ): { companyName: string; branchName: string | null } {
    if (frozenCompanyName) {
      return { companyName: frozenCompanyName, branchName: frozenBranchName }
    }

    // Historical fallback (plan §D-2): the CURRENT bootstrap name, only when there is no frozen
    // context row. Callers already add the historical notice in this case.
    const company = this.dependencies.bootstrapSnapshot.getCompany()
    const branch = this.dependencies.bootstrapSnapshot.getBranch()
    return { companyName: company?.name ?? 'Store', branchName: branch?.name ?? null }
  }

  /** Branding is read ONLY from the captured/current profile VERSION, never re-derived from a
   *  live "current" pointer for a sale/refund (plan §D-11) — a later profile edit must never
   *  change an existing receipt. A NULL version (no profile existed/mirrored at that time, or the
   *  lookup dependency is absent) means no branding at all, never a substitution from elsewhere. */
  private resolveBranding(
    companyUuid: string | null,
    receiptProfileVersionUuid: string | null
  ): {
    header: {
      addressLines: string[]
      phone: string | null
      taxIdentifierLabel: string | null
      taxIdentifierValue: string | null
      logo: { sha256: string; included: boolean; size?: 'small' | 'medium' | 'large' } | null
    }
    footerLines: string[]
    display: { showBranch: boolean; showCashier: boolean; showCustomer: boolean }
  } {
    const empty = {
      header: {
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        logo: null
      },
      footerLines: [],
      display: { showBranch: true, showCashier: true, showCustomer: true }
    }

    if (!companyUuid || !receiptProfileVersionUuid || !this.dependencies.receiptProfile) {
      return empty
    }

    const version = this.dependencies.receiptProfile.getVersion(
      receiptProfileVersionUuid,
      companyUuid
    )
    if (!version) {
      return empty
    }

    // POS improvements, Stage 6 (profile v2): the version's display choices hide OPTIONAL decoration
    // only; null (a v1 version) shows everything. Fiscal fields and the QR are built elsewhere.
    const display = version.displayOptions ?? null
    return {
      header: {
        addressLines: display?.show_address === false ? [] : [...version.addressLines],
        phone: display?.show_phone === false ? null : version.phone,
        taxIdentifierLabel: version.taxIdentifierLabel,
        taxIdentifierValue: version.taxIdentifierValue,
        logo: version.logoSha256
          ? {
              sha256: version.logoSha256,
              included: version.logoAvailable,
              ...(display ? { size: display.logo_size } : {})
            }
          : null
      },
      footerLines: display?.show_footer === false ? [] : [...version.footerLines],
      display: {
        showBranch: display?.show_branch !== false,
        showCashier: display?.show_cashier !== false,
        showCustomer: display?.show_customer !== false
      }
    }
  }

  private ownDiscount(item: LocalInvoiceItemRow): number {
    const result = calculateDiscount(
      BigInt(item.subtotalAmount),
      item.discountType,
      item.discountValue
    )
    return result.ok ? Number(result.value) : item.discountAmount
  }

  private quantityText(milli: number): string {
    const result = formatQuantity(milli)
    return result.ok ? result.value : String(milli / 1000)
  }

  private buildSaleItemLine(
    item: LocalInvoiceItemRow,
    _locale: ReceiptLocale,
    strings: ReturnType<typeof receiptStrings>,
    money: (amount: number) => string
  ): ReceiptItemLine {
    void strings
    const own = this.ownDiscount(item)
    const invoiceShare = Math.max(0, item.discountAmount - own)

    return {
      productName: item.productName,
      sku: item.sku,
      quantityText: this.quantityText(item.quantityMilli),
      unit: item.unit,
      unitPriceText: money(item.unitPriceAmount),
      lineTotalText: money(item.totalAmount),
      ownDiscountText: own > 0 ? money(own) : null,
      invoiceDiscountShareText: invoiceShare > 0 ? money(invoiceShare) : null,
      taxRateLabel: item.taxRateBasisPoints > 0 ? `${item.taxRateBasisPoints / 100}%` : null
    }
  }

  private groupTaxByRate(
    items: readonly LocalInvoiceItemRow[],
    money: (amount: number) => string
  ): ReceiptTaxLine[] {
    const byRate = new Map<number, number>()

    for (const item of items) {
      byRate.set(
        item.taxRateBasisPoints,
        (byRate.get(item.taxRateBasisPoints) ?? 0) + item.taxAmount
      )
    }

    return [...byRate.entries()]
      .filter(([rate, amount]) => rate > 0 && amount > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([rate, amount]) => ({ rateLabel: `${rate / 100}%`, amountText: money(amount) }))
  }
}
