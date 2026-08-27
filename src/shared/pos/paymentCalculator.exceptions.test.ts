import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CatalogContract } from '@shared/contracts/catalog.contract'
import { calculateCart, type CartCalculationErrorCode, type DiscountType } from './posCalculator'
import {
  calculatePayments,
  type PaymentErrorCode,
  type ResolvedPaymentMethod
} from './paymentCalculator'

interface GoldenCase {
  readonly name: string
  readonly input: {
    readonly items: ReadonlyArray<{
      readonly productUuid: string
      readonly quantity: string
      readonly unitPriceAmount: number
      readonly discountType: DiscountType
      readonly discountValue: number
      readonly taxMode: 'none' | 'inclusive' | 'exclusive'
      readonly taxRateBasisPoints: number
    }>
    readonly invoiceDiscountType: DiscountType
    readonly invoiceDiscountValue: number
    readonly payments: ReadonlyArray<{ readonly type: string; readonly amount: number }>
  }
  readonly rejects: { readonly rule: string }
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/pos-calculator-exceptions-golden.json', import.meta.url),
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
 * The backend bundles cart and payment arithmetic in one `PosCalculator::calculate()` call, so one
 * exception fixture covers both. The desktop deliberately splits them into `calculateCart` and
 * `calculatePayments`; this table is this file's half of the identifier contract BE-3E-1 defines —
 * never an English message.
 */
const CART_RULE_TO_CODE: Readonly<Record<string, CartCalculationErrorCode>> = {
  discount_exceeds_amount: 'CART_DISCOUNT_EXCEEDS_AMOUNT',
  discount_percentage_over_maximum: 'CART_DISCOUNT_INVALID',
  discount_type_required: 'CART_DISCOUNT_INVALID',
  quantity_invalid: 'CART_QUANTITY_INVALID',
  quantity_out_of_range: 'CART_QUANTITY_OUT_OF_RANGE',
  tax_rate_not_allowed_for_mode: 'CART_PRODUCT_SNAPSHOT_INVALID',
  line_total_limit: 'CART_LINE_TOTAL_LIMIT',
  invoice_total_limit: 'CART_INVOICE_TOTAL_LIMIT'
}

const PAYMENT_RULE_TO_CODE: Readonly<Record<string, PaymentErrorCode>> = {
  payment_negative: 'PAYMENT_AMOUNT_INVALID',
  payment_total_limit: 'PAYMENT_AMOUNT_LIMIT'
}

function resolvedMethods(
  payments: ReadonlyArray<{ readonly type: string }>
): readonly ResolvedPaymentMethod[] {
  const types = [...new Set(payments.map((payment) => payment.type))]

  return types.map((type) => ({
    uuid: `method-${type}`,
    type: type as ResolvedPaymentMethod['type'],
    isActive: true,
    requiresReference: false,
    allowsChange: true
  }))
}

describe('backend POS calculator exception fixture', () => {
  it.each(fixture.cases)(
    '$name maps to the same normalized rejection identifier as the backend',
    (case_) => {
      const cart = calculateCart(
        case_.input.items.map((item, index) => ({ id: `line-${index}`, ...item, currency: 'EGP' })),
        contract,
        case_.input.invoiceDiscountType,
        case_.input.invoiceDiscountValue
      )

      if (!cart.ok) {
        const expectedCode = CART_RULE_TO_CODE[case_.rejects.rule]
        expect(
          expectedCode,
          `no cart mapping declared for rule "${case_.rejects.rule}"`
        ).toBeDefined()
        expect(cart.code).toBe(expectedCode)
        return
      }

      const methods = resolvedMethods(case_.input.payments)
      const rows = case_.input.payments.map((payment, index) => ({
        id: `payment-${index}`,
        methodUuid: `method-${payment.type}`,
        amount: payment.amount,
        reference: null
      }))
      const result = calculatePayments(rows, methods, cart.value.grandTotalAmount)

      expect(result.ok, `case "${case_.name}" unexpectedly succeeded at both layers`).toBe(false)
      if (!result.ok) {
        const expectedCode = PAYMENT_RULE_TO_CODE[case_.rejects.rule]
        expect(
          expectedCode,
          `no payment mapping declared for rule "${case_.rejects.rule}"`
        ).toBeDefined()
        expect(result.code).toBe(expectedCode)
      }
    }
  )
})
