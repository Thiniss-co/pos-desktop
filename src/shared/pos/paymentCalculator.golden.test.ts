import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CatalogContract } from '@shared/contracts/catalog.contract'
import { calculateCart, type DiscountType } from './posCalculator'
import { calculatePayments, type ResolvedPaymentMethod } from './paymentCalculator'

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
    readonly payments?: ReadonlyArray<{ readonly type: string; readonly amount: number }>
  }
  readonly expected: {
    readonly paidTotalAmount?: number
    readonly changeDueAmount?: number
    readonly dueAmount?: number
  }
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/pos-calculator-golden.json', import.meta.url),
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

describe('backend payment calculator golden fixture', () => {
  const paymentCases = fixture.cases.filter(
    (
      case_
    ): case_ is GoldenCase & {
      input: { payments: NonNullable<GoldenCase['input']['payments']> }
    } => case_.input.payments !== undefined
  )

  it.each(paymentCases)('$name matches byte-for-byte committed backend expectations', (case_) => {
    const cart = calculateCart(
      case_.input.items.map((item, index) => ({ id: `line-${index}`, ...item, currency: 'EGP' })),
      contract,
      case_.input.invoiceDiscountType,
      case_.input.invoiceDiscountValue
    )

    expect(cart).toMatchObject({ ok: true })
    if (!cart.ok) {
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

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect({
        paidTotalAmount: result.value.paidTotalAmount,
        changeDueAmount: result.value.changeDueAmount,
        dueAmount: result.value.dueAmount
      }).toEqual({
        paidTotalAmount: case_.expected.paidTotalAmount,
        changeDueAmount: case_.expected.changeDueAmount,
        dueAmount: case_.expected.dueAmount
      })
    }
  })
})
