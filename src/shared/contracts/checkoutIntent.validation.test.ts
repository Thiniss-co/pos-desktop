import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CatalogContract } from './catalog.contract'
import { calculateCart } from '@shared/pos/posCalculator'
import {
  calculatePayments,
  type PaymentErrorCode,
  type ResolvedPaymentMethod
} from '@shared/pos/paymentCalculator'
import { checkoutIntentSchema, type CheckoutIntent } from './checkout.contract'

interface GoldenCase {
  readonly name: string
  readonly payload: {
    readonly items: ReadonlyArray<{
      readonly product_uuid: string
      readonly quantity: string
      readonly unit_price_amount: number
      readonly tax_mode: 'none' | 'inclusive' | 'exclusive'
      readonly tax_rate_basis_points: number
      readonly discount_type: 'fixed' | 'percentage' | null
      readonly discount_value: number
    }>
    readonly invoice_discount: {
      readonly type: 'fixed' | 'percentage' | null
      readonly value: number
    }
    readonly payments: ReadonlyArray<{ readonly type: string; readonly amount: number }>
  }
  readonly rejects: ReadonlyArray<{ readonly field: string; readonly rule: string }>
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/pos-request-validation-golden.json', import.meta.url),
    'utf8'
  )
) as { readonly cases: readonly GoldenCase[] }

const contract: CatalogContract = {
  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generatedAt: '2026-01-01T00:00:00Z',
  validUntil: '2026-01-04T00:00:00Z',
  currency: 'EGP',
  currencyExponent: 2,
  quantityScale: 3,
  minimumQuantity: '0.001',
  maximumQuantity: '999999.999',
  maximumUnitPrice: 1_000_000_000,
  maximumLineTotal: 900_000_000_000_000,
  maximumInvoiceTotal: 900_000_000_000_000,
  mixedTaxModePolicy: 'single_invoice_mode'
}

/**
 * These six cases are rows 3, 5, 6, 7, 8, 10 of the frozen "Payment example table". Rows 7 and 10
 * are Laravel FormRequest field rejections (`required`, `min`) — the desktop mirrors that at the
 * same layer, `checkoutIntentSchema` itself, never reaching `calculatePayments`. Rows 3, 5, 6 are
 * `PosPaymentValidator` business rejections and map identifier-to-identifier onto a
 * `calculatePayments` code. Row 8 (`payment-zero-cash-tender`) is the one documented exception:
 * Laravel has no zero-amount rule of its own and rejects it via coverage
 * (`payment_coverage_insufficient`), but the desktop's stricter, desktop-only zero-tender rule
 * (frozen contract matrix, "Zero tender / no rows / zero-total sale") fires first and reports
 * `PAYMENT_AMOUNT_ZERO` instead — a deliberate, stricter divergence, not a parity gap.
 */
const SCHEMA_LEVEL_CASES = new Set(['payments-empty', 'payment-negative-amount'])

const BUSINESS_RULE_TO_CODE: Readonly<Record<string, PaymentErrorCode>> = {
  payment_coverage_insufficient: 'PAYMENT_INSUFFICIENT_TENDER',
  payment_non_cash_overpayment: 'PAYMENT_NON_CASH_OVERPAYMENT'
}

const DOCUMENTED_DIVERGENCES: Readonly<Record<string, PaymentErrorCode>> = {
  'payment-zero-cash-tender': 'PAYMENT_AMOUNT_ZERO'
}

function toIntent(payload: GoldenCase['payload']): CheckoutIntent {
  return {
    draftRevision: 1,
    catalogRevision: contract.revision,
    items: payload.items.map((item, index) => ({
      id: `item-${index}`,
      productUuid: item.product_uuid,
      quantity: item.quantity,
      discountType: item.discount_type,
      discountValue: item.discount_value
    })),
    invoiceDiscount: {
      discountType: payload.invoice_discount.type,
      discountValue: payload.invoice_discount.value
    },
    customerUuid: null,
    payments: payload.payments.map((payment, index) => ({
      id: `payment-${index}`,
      paymentMethodUuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
      amount: payment.amount,
      reference: null
    }))
  }
}

function resolvedMethods(
  payments: GoldenCase['payload']['payments']
): readonly ResolvedPaymentMethod[] {
  return payments.map((payment, index) => ({
    uuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
    type: payment.type as ResolvedPaymentMethod['type'],
    isActive: true,
    requiresReference: false,
    allowsChange: true
  }))
}

describe('backend request-validation golden fixture', () => {
  it.each(fixture.cases)('$name rejects at the same layer Laravel does', (case_) => {
    const intent = toIntent(case_.payload)
    const parsed = checkoutIntentSchema.safeParse(intent)

    if (SCHEMA_LEVEL_CASES.has(case_.name)) {
      expect(parsed.success, `expected a schema-level rejection for "${case_.name}"`).toBe(false)
      return
    }

    expect(parsed.success, `expected "${case_.name}" to pass schema validation`).toBe(true)
    if (!parsed.success) {
      return
    }

    const items = case_.payload.items.map((item, index) => ({
      id: `item-${index}`,
      productUuid: item.product_uuid,
      quantity: item.quantity,
      unitPriceAmount: item.unit_price_amount,
      currency: 'EGP',
      discountType: item.discount_type,
      discountValue: item.discount_value,
      taxMode: item.tax_mode,
      taxRateBasisPoints: item.tax_rate_basis_points
    }))
    const cart = calculateCart(
      items,
      contract,
      case_.payload.invoice_discount.type,
      case_.payload.invoice_discount.value
    )

    expect(cart.ok, `expected "${case_.name}"'s cart arithmetic to succeed`).toBe(true)
    if (!cart.ok) {
      return
    }

    const rows = case_.payload.payments.map((payment, index) => ({
      id: `payment-${index}`,
      methodUuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
      amount: payment.amount,
      reference: null
    }))
    const result = calculatePayments(
      rows,
      resolvedMethods(case_.payload.payments),
      cart.value.grandTotalAmount
    )

    expect(result.ok, `expected "${case_.name}" to be rejected by calculatePayments`).toBe(false)
    if (result.ok) {
      return
    }

    const divergence = DOCUMENTED_DIVERGENCES[case_.name]
    if (divergence) {
      expect(result.code).toBe(divergence)
      return
    }

    const rule = case_.rejects[0]?.rule
    const expectedCode = rule ? BUSINESS_RULE_TO_CODE[rule] : undefined
    expect(expectedCode, `no business-rule mapping declared for rule "${rule}"`).toBeDefined()
    expect(result.code).toBe(expectedCode)
  })
})
