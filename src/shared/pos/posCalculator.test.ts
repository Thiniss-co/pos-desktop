import { describe, expect, it } from 'vitest'
import type { CatalogContract } from '@shared/contracts/catalog.contract'
import { calculateCart, type CartCalculation, type CartCalculationInputLine } from './posCalculator'

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

function line(overrides: Partial<CartCalculationInputLine> = {}): CartCalculationInputLine {
  return {
    id: 'line-1',
    productUuid: '00000000-0000-4000-8000-000000000001',
    quantity: '1.000',
    unitPriceAmount: 1000,
    currency: 'EGP',
    taxMode: 'none',
    taxRateBasisPoints: 0,
    ...overrides
  }
}

function calculated(...args: Parameters<typeof calculateCart>): CartCalculation {
  const result = calculateCart(...args)
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) {
    throw new Error(result.code)
  }
  return result.value
}

describe('calculateCart Laravel compatibility', () => {
  it('matches none, exclusive, and inclusive tax golden values', () => {
    expect(calculated([line()], contract).grandTotalAmount).toBe(1000)
    expect(
      calculated([line({ taxMode: 'exclusive', taxRateBasisPoints: 1500 })], contract)
    ).toMatchObject({ taxTotalAmount: 150, grandTotalAmount: 1150 })
    expect(
      calculated(
        [line({ unitPriceAmount: 1150, taxMode: 'inclusive', taxRateBasisPoints: 1500 })],
        contract
      )
    ).toMatchObject({ taxTotalAmount: 150, grandTotalAmount: 1150 })
  })

  it('matches fixed and percentage discount ordering and half-up rounding', () => {
    const fixed = calculated(
      [line({ discountType: 'fixed', discountValue: 100 })],
      contract,
      'fixed',
      50
    )
    const percentage = calculated(
      [line({ discountType: 'percentage', discountValue: 1000 })],
      contract,
      'percentage',
      1000
    )

    expect(fixed).toMatchObject({ discountTotalAmount: 150, grandTotalAmount: 850 })
    expect(percentage).toMatchObject({ discountTotalAmount: 190, grandTotalAmount: 810 })
    expect(
      calculated(
        [
          line({ id: 'a', quantity: '1.500', unitPriceAmount: 101 }),
          line({
            id: 'b',
            productUuid: '00000000-0000-4000-8000-000000000002',
            quantity: '2.000',
            unitPriceAmount: 100
          })
        ],
        contract
      )
    ).toMatchObject({ subtotalAmount: 352, grandTotalAmount: 352 })
  })

  it('uses backend-compatible largest-remainder allocation independent of input order', () => {
    const first = line({
      id: 'a',
      productUuid: '00000000-0000-4000-8000-000000000003',
      unitPriceAmount: 333,
      taxMode: 'exclusive',
      taxRateBasisPoints: 500
    })
    const second = line({
      id: 'b',
      productUuid: '00000000-0000-4000-8000-000000000001',
      unitPriceAmount: 667,
      taxMode: 'exclusive',
      taxRateBasisPoints: 1500
    })
    const forward = calculated([first, second], contract, 'fixed', 101)
    const reverse = calculated([second, first], contract, 'fixed', 101)

    expect(forward.discountTotalAmount).toBe(101)
    expect(forward.lines.map((item) => item.discountAmount)).toEqual([34, 67])
    expect(forward.grandTotalAmount).toBe(1004)
    expect(new Map(forward.lines.map((item) => [item.id, item.discountAmount]))).toEqual(
      new Map(reverse.lines.map((item) => [item.id, item.discountAmount]))
    )
  })

  it('conserves the invoice discount across every permutation', () => {
    const inputs = [
      line({
        id: 'one',
        productUuid: '00000000-0000-4000-8000-000000000001',
        unitPriceAmount: 333
      }),
      line({
        id: 'two',
        productUuid: '00000000-0000-4000-8000-000000000002',
        unitPriceAmount: 667
      }),
      line({
        id: 'three',
        productUuid: '00000000-0000-4000-8000-000000000003',
        unitPriceAmount: 1000
      })
    ]
    const permutations = [
      inputs,
      [inputs[2]!, inputs[1]!, inputs[0]!],
      [inputs[1]!, inputs[0]!, inputs[2]!]
    ]

    const expectedById = new Map(
      calculated(inputs, contract, 'fixed', 101).lines.map((item) => [item.id, item.discountAmount])
    )

    for (const permutation of permutations) {
      const result = calculated(permutation, contract, 'fixed', 101)
      expect(result.discountTotalAmount).toBe(101)
      expect(result.lines.reduce((total, item) => total + item.discountAmount, 0)).toBe(101)
      expect(new Map(result.lines.map((item) => [item.id, item.discountAmount]))).toEqual(
        expectedById
      )
    }
  })

  it('documents the largest-remainder monotonicity limitation', () => {
    const items = [
      line({
        id: 'one',
        productUuid: '00000000-0000-4000-8000-000000000001',
        unitPriceAmount: 1,
        taxMode: 'exclusive',
        taxRateBasisPoints: 0
      }),
      line({
        id: 'two',
        productUuid: '00000000-0000-4000-8000-000000000002',
        unitPriceAmount: 3,
        taxMode: 'exclusive',
        taxRateBasisPoints: 3000
      }),
      line({
        id: 'three',
        productUuid: '00000000-0000-4000-8000-000000000003',
        unitPriceAmount: 3,
        taxMode: 'exclusive',
        taxRateBasisPoints: 6000
      })
    ]

    expect(
      calculated(items, contract, 'fixed', 3).lines.map((item) => item.discountAmount)
    ).toEqual([1, 1, 1])
    expect(
      calculated(items, contract, 'fixed', 4).lines.map((item) => item.discountAmount)
    ).toEqual([0, 2, 2])
  })

  it('returns validation failures instead of throwing on invalid user input', () => {
    expect(
      calculateCart(
        [line(), line({ id: 'taxed', taxMode: 'exclusive', taxRateBasisPoints: 1500 })],
        contract
      )
    ).toEqual({ ok: false, code: 'CART_MIXED_TAX_MODE' })
    expect(calculateCart([line({ quantity: '1000000.000' })], contract)).toEqual({
      ok: false,
      code: 'CART_QUANTITY_OUT_OF_RANGE'
    })
    expect(calculateCart([line({ discountValue: Number.NaN })], contract)).toEqual({
      ok: false,
      code: 'CART_DISCOUNT_INVALID'
    })
    expect(() => calculateCart([line({ unitPriceAmount: 1.5 })], contract)).not.toThrow()
  })
})
