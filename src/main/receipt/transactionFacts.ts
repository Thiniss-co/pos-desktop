import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow
} from '@shared/contracts/sale.contract'
import type {
  LocalRefundItemRow,
  LocalRefundPaymentRow,
  LocalRefundRow
} from '@shared/contracts/refund.contract'
import { canonicalJson, sha256Hex } from '../services/localSale.fingerprint'

/**
 * Receipt-printing plan §D-9 — a versioned, explicit projection of the IMMUTABLE persisted
 * transaction facts a receipt prints, used ONLY to detect tampering/corruption of the underlying
 * rows between claim and dispatch (the final print-job gate, plan §D-5 C step 8.5). Deliberately
 * excludes everything presentational or operational: the reprint marker, locale, template version,
 * current bootstrap fallback names, time zone, printer/settings/geometry, sync status, and any
 * post-acknowledgement metadata (server_number, refund_number). Adding a server number to a synced
 * invoice, printing a reprint, or changing the locale must never change this hash — see
 * `transactionFacts.test.ts`.
 *
 * Every listed key is always present in the serialized object (no optional keys) so `undefined`
 * can never silently vanish under JSON.stringify. Money and quantity fields are validated as safe
 * integers; nothing here is ever recalculated from current catalog data.
 */

const SALE_FACTS_PROJECTION = 'sale-facts/1' as const
const REFUND_FACTS_PROJECTION = 'refund-facts/1' as const

function safeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`transactionFacts: ${field} is not a safe integer (${value})`)
  }
  return value
}

export interface SaleFactsInput {
  readonly invoice: LocalInvoiceRow
  readonly items: readonly LocalInvoiceItemRow[]
  readonly payments: readonly LocalInvoicePaymentRow[]
}

export interface RefundFactsInput {
  readonly refund: LocalRefundRow
  readonly items: readonly LocalRefundItemRow[]
  readonly payments: readonly LocalRefundPaymentRow[]
}

export interface TransactionFacts {
  readonly projection: typeof SALE_FACTS_PROJECTION | typeof REFUND_FACTS_PROJECTION
  readonly json: string
  readonly sha256: string
}

export function buildSaleFacts(input: SaleFactsInput): TransactionFacts {
  const { invoice, items, payments } = input

  const projected = {
    projection: SALE_FACTS_PROJECTION,
    invoice: {
      local_uuid: invoice.localUuid,
      attempt_key: invoice.attemptKey,
      offline_number: invoice.offlineNumber,
      company_uuid: invoice.companyUuid,
      device_uuid: invoice.deviceUuid,
      branch_uuid: invoice.branchUuid,
      warehouse_uuid: invoice.warehouseUuid,
      user_uuid: invoice.userUuid,
      shift_uuid: invoice.shiftUuid,
      customer_uuid: invoice.customerUuid,
      sold_at: invoice.soldAt,
      currency: invoice.currency,
      currency_exponent: safeInt(invoice.currencyExponent, 'invoice.currencyExponent'),
      tax_mode: invoice.taxMode,
      invoice_discount_type: invoice.invoiceDiscountType,
      invoice_discount_value: safeInt(invoice.invoiceDiscountValue, 'invoice.invoiceDiscountValue'),
      subtotal_amount: safeInt(invoice.subtotalAmount, 'invoice.subtotalAmount'),
      discount_total_amount: safeInt(invoice.discountTotalAmount, 'invoice.discountTotalAmount'),
      tax_total_amount: safeInt(invoice.taxTotalAmount, 'invoice.taxTotalAmount'),
      grand_total_amount: safeInt(invoice.grandTotalAmount, 'invoice.grandTotalAmount'),
      paid_total_amount: safeInt(invoice.paidTotalAmount, 'invoice.paidTotalAmount'),
      change_due_amount: safeInt(invoice.changeDueAmount, 'invoice.changeDueAmount'),
      due_amount: safeInt(invoice.dueAmount, 'invoice.dueAmount')
    },
    items: [...items]
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((item) => ({
        local_uuid: item.localUuid,
        line_index: safeInt(item.lineIndex, 'item.lineIndex'),
        product_uuid: item.productUuid,
        product_name: item.productName,
        sku: item.sku,
        barcode: item.barcode,
        unit: item.unit,
        quantity_milli: safeInt(item.quantityMilli, 'item.quantityMilli'),
        unit_price_amount: safeInt(item.unitPriceAmount, 'item.unitPriceAmount'),
        currency: item.currency,
        tax_mode: item.taxMode,
        tax_rate_basis_points: safeInt(item.taxRateBasisPoints, 'item.taxRateBasisPoints'),
        discount_type: item.discountType,
        discount_value: safeInt(item.discountValue, 'item.discountValue'),
        subtotal_amount: safeInt(item.subtotalAmount, 'item.subtotalAmount'),
        discount_amount: safeInt(item.discountAmount, 'item.discountAmount'),
        tax_amount: safeInt(item.taxAmount, 'item.taxAmount'),
        total_amount: safeInt(item.totalAmount, 'item.totalAmount')
      })),
    payments: [...payments]
      .sort((a, b) => a.paymentIndex - b.paymentIndex)
      .map((payment) => ({
        local_uuid: payment.localUuid,
        payment_index: safeInt(payment.paymentIndex, 'payment.paymentIndex'),
        payment_method_uuid: payment.paymentMethodUuid,
        type: payment.type,
        amount: safeInt(payment.amount, 'payment.amount'),
        reference: payment.reference,
        paid_at: payment.paidAt,
        method_snapshot_json: payment.methodSnapshotJson
      }))
  }

  const json = canonicalJson(projected)
  return { projection: SALE_FACTS_PROJECTION, json, sha256: sha256Hex(json) }
}

export function buildRefundFacts(input: RefundFactsInput): TransactionFacts {
  const { refund, items, payments } = input

  const projected = {
    projection: REFUND_FACTS_PROJECTION,
    refund: {
      local_uuid: refund.localUuid,
      invoice_local_uuid: refund.invoiceLocalUuid,
      invoice_remote_uuid: refund.invoiceRemoteUuid,
      company_uuid: refund.companyUuid,
      device_uuid: refund.deviceUuid,
      user_uuid: refund.userUuid,
      shift_uuid: refund.shiftUuid,
      currency: refund.currency,
      currency_exponent: safeInt(refund.currencyExponent, 'refund.currencyExponent'),
      subtotal_amount: safeInt(refund.subtotalAmount, 'refund.subtotalAmount'),
      discount_total_amount: safeInt(refund.discountTotalAmount, 'refund.discountTotalAmount'),
      tax_total_amount: safeInt(refund.taxTotalAmount, 'refund.taxTotalAmount'),
      grand_total_amount: safeInt(refund.grandTotalAmount, 'refund.grandTotalAmount'),
      refunded_at: refund.refundedAt,
      stock_returned: refund.stockReturned,
      reason: refund.reason
    },
    items: [...items]
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((item) => ({
        local_uuid: item.localUuid,
        line_index: safeInt(item.lineIndex, 'item.lineIndex'),
        invoice_item_remote_uuid: item.invoiceItemRemoteUuid,
        product_uuid: item.productUuid,
        product_name: item.productName,
        quantity_milli: safeInt(item.quantityMilli, 'item.quantityMilli'),
        prior_refunded_quantity_milli: safeInt(
          item.priorRefundedQuantityMilli,
          'item.priorRefundedQuantityMilli'
        ),
        subtotal_amount: safeInt(item.subtotalAmount, 'item.subtotalAmount'),
        discount_amount: safeInt(item.discountAmount, 'item.discountAmount'),
        tax_amount: safeInt(item.taxAmount, 'item.taxAmount'),
        total_amount: safeInt(item.totalAmount, 'item.totalAmount'),
        tax_mode: item.taxMode
      })),
    payments: [...payments]
      .sort((a, b) => a.paymentIndex - b.paymentIndex)
      .map((payment) => ({
        local_uuid: payment.localUuid,
        payment_index: safeInt(payment.paymentIndex, 'payment.paymentIndex'),
        payment_method_uuid: payment.paymentMethodUuid,
        type: payment.type,
        amount: safeInt(payment.amount, 'payment.amount'),
        reference: payment.reference
      }))
  }

  const json = canonicalJson(projected)
  return { projection: REFUND_FACTS_PROJECTION, json, sha256: sha256Hex(json) }
}
