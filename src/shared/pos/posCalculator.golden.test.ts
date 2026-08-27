import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CatalogContract } from '@shared/contracts/catalog.contract'
import { calculateCart, type DiscountType } from './posCalculator'

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
    readonly payments?: ReadonlyArray<unknown>
  }
  readonly expected: unknown
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

describe('backend POS calculator golden fixture', () => {
  const cartOnlyCases = fixture.cases.filter((case_) => case_.input.payments === undefined)

  it.each(cartOnlyCases)('$name matches byte-for-byte committed backend expectations', (case_) => {
    const result = calculateCart(
      case_.input.items.map((item, index) => ({ id: `line-${index}`, ...item, currency: 'EGP' })),
      contract,
      case_.input.invoiceDiscountType,
      case_.input.invoiceDiscountValue
    )

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect({
        ...result.value,
        lines: result.value.lines.map((item) => ({
          subtotalAmount: item.subtotalAmount,
          discountAmount: item.discountAmount,
          taxAmount: item.taxAmount,
          totalAmount: item.totalAmount
        }))
      }).toEqual(case_.expected)
    }
  })
})
