import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import type { LocalInvoiceItemRow } from '@shared/contracts/sale.contract'
import { calculateDiscount, formatQuantity } from '@shared/pos/posCalculator'
import { formatReceiptMoney } from '@shared/receipt/receiptMoney'
import { receiptStrings } from '@shared/receipt/receiptStrings'
import type {
  ReceiptDocument,
  ReceiptItemLine,
  ReceiptLocale,
  ReceiptTaxLine
} from '@shared/receipt/receiptDocument'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { LocalRefundRepository } from '../repositories/localRefund.repository'
import type { ReceiptContextRepository } from '../repositories/receiptContext.repository'
import type { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import type { ReceiptProfileRepository } from '../repositories/receiptProfile.repository'

/**
 * Receipt-printing plan §D-2/§D-9 — builds the frozen, printable `ReceiptDocument` from persisted
 * rows ONLY. This dependency type has no API client: printing an offline sale never makes a
 * network call. Every value is derived from stored snapshot columns; nothing here reads current
 * catalog prices, current tax settings or current `track_stock`.
 */

export const RECEIPT_TEMPLATE_VERSION = 1

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
}

function notFound(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'This receipt could not be found.',
    backendCode: 'receipt_not_found',
    retryable: false
  })
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
    // The offset is computed in the WORKSTATION's local zone (there is no reliable
    // Intl-only way to get a named zone's offset without a heavier dependency); when
    // `timeZone` differs from the workstation, this is a close, honestly-labelled
    // approximation rather than a silently wrong one.
    return `${formatted} (${formatOffset(date)})`
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
    const header = { ...names, ...branding.header }

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
        cashierName: context?.cashierDisplayName ?? null,
        customerName: context?.customerName ?? null,
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
      footer: branding.footerLines
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
    const header = { ...names, ...branding.header }

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
          taxRateLabel: descriptor?.taxRateText ? `${descriptor.taxRateText}%` : null
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
        cashierName: context?.cashierDisplayName ?? null,
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
      footer: branding.footerLines
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
    const header = { ...names, ...branding.header }
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
      logo: { sha256: string; included: boolean } | null
    }
    footerLines: string[]
  } {
    const empty = {
      header: {
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        logo: null
      },
      footerLines: []
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

    return {
      header: {
        addressLines: [...version.addressLines],
        phone: version.phone,
        taxIdentifierLabel: version.taxIdentifierLabel,
        taxIdentifierValue: version.taxIdentifierValue,
        logo: version.logoSha256
          ? { sha256: version.logoSha256, included: version.logoAvailable }
          : null
      },
      footerLines: [...version.footerLines]
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
