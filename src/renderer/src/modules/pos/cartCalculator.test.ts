import { describe, expect, it } from 'vitest'
import type { CatalogContract } from '@shared/contracts/catalog.contract'
import { calculateCart, CartDomainError } from './cartCalculator'

const contract: CatalogContract = {
  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generatedAt: '2026-01-01T00:00:00Z',
  validUntil: '2026-01-04T00:00:00Z',
  quantityScale: 3,
  minimumQuantity: '0.001',
  maximumQuantity: '999999.999',
  maximumUnitPrice: 1_000_000_000,
  maximumLineTotal: 900_000_000_000_000,
  maximumInvoiceTotal: 900_000_000_000_000,
  mixedTaxModePolicy: 'single_invoice_mode'
}

function line(
  overrides: Partial<Parameters<typeof calculateCart>[0][number]> = {}
): Parameters<typeof calculateCart>[0][number] {
  return {
    id: 'line-1',
    quantity: '1.000',
    unitPriceAmount: 1000,
    currency: 'EGP',
    taxMode: 'none',
    taxRateBasisPoints: 0,
    ...overrides
  }
}

describe('calculateCart Laravel compatibility', () => {
  it('matches none, exclusive, and inclusive tax golden values', () => {
    expect(calculateCart([line()], contract).grandTotalAmount).toBe(1000)
    expect(
      calculateCart([line({ taxMode: 'exclusive', taxRateBasisPoints: 1500 })], contract)
    ).toMatchObject({ taxTotalAmount: 150, grandTotalAmount: 1150 })
    expect(
      calculateCart(
        [line({ unitPriceAmount: 1150, taxMode: 'inclusive', taxRateBasisPoints: 1500 })],
        contract
      )
    ).toMatchObject({ taxTotalAmount: 150, grandTotalAmount: 1150 })
  })

  it('matches fixed and percentage discount ordering and half-up rounding', () => {
    const fixed = calculateCart(
      [line({ discountType: 'fixed', discountValue: 100 })],
      contract,
      'fixed',
      50
    )
    const percentage = calculateCart(
      [line({ discountType: 'percentage', discountValue: 1000 })],
      contract,
      'percentage',
      1000
    )

    expect(fixed).toMatchObject({ discountTotalAmount: 150, grandTotalAmount: 850 })
    expect(percentage).toMatchObject({ discountTotalAmount: 190, grandTotalAmount: 810 })
    expect(
      calculateCart(
        [
          line({ id: 'a', quantity: '1.500', unitPriceAmount: 101 }),
          line({ id: 'b', quantity: '2.000', unitPriceAmount: 100 })
        ],
        contract
      )
    ).toMatchObject({ subtotalAmount: 352, grandTotalAmount: 352 })
  })

  it('allocates an invoice discount proportionally and assigns the remainder to the last line', () => {
    const result = calculateCart(
      [line({ id: 'a', unitPriceAmount: 333 }), line({ id: 'b', unitPriceAmount: 667 })],
      contract,
      'fixed',
      101
    )

    expect(result.discountTotalAmount).toBe(101)
    expect(result.lines.map((item) => item.discountAmount)).toEqual([34, 67])
    expect(result.grandTotalAmount).toBe(899)
  })

  it('enforces the frozen tax-mode and published overflow boundaries', () => {
    expect(() =>
      calculateCart(
        [line(), line({ id: 'taxed', taxMode: 'exclusive', taxRateBasisPoints: 1500 })],
        contract
      )
    ).toThrowError(expect.objectContaining({ code: 'CART_MIXED_TAX_MODE' }))

    expect(
      calculateCart([line({ quantity: '900000.000', unitPriceAmount: 1_000_000_000 })], contract)
        .grandTotalAmount
    ).toBe(900_000_000_000_000)
    expect(() =>
      calculateCart([line({ quantity: '900000.001', unitPriceAmount: 1_000_000_000 })], contract)
    ).toThrow(CartDomainError)
    expect(() => calculateCart([line({ quantity: '1000000.000' })], contract)).toThrow(
      CartDomainError
    )
  })
})
