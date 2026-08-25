import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'
import { i18n } from '@renderer/i18n'
import { useCartStore } from './cart.store'

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

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    uuid: '11111111-1111-4111-8111-111111111111',
    categoryUuid: '22222222-2222-4222-8222-222222222222',
    name: 'Water',
    sku: 'WATER',
    barcode: '12345',
    description: null,
    unit: 'each',
    trackStock: false,
    availableQuantity: null,
    price: {
      amount: 1000,
      currency: 'EGP',
      source: 'product_base',
      revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-01-04T00:00:00Z'
    },
    tax: {
      id: null,
      mode: 'none',
      rateBasisPoints: 0,
      revision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    },
    ...overrides
  }
}

describe('useCartStore', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    i18n.global.locale.value = 'en'
  })

  it('freezes calculation-significant snapshots and merges only identical revisions', () => {
    const store = useCartStore()
    const source = product()
    store.setContract(contract)
    expect(store.addProduct(source)).toBe(true)
    source.price.amount = 5000
    expect(store.lines[0]?.product.price.amount).toBe(1000)
    expect(store.addProduct(source)).toBe(true)
    expect(store.lines).toHaveLength(2)
  })

  it('rolls back a conflicting tax-mode addition', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    const taxed = product({
      uuid: '33333333-3333-4333-8333-333333333333',
      tax: {
        id: '44444444-4444-4444-8444-444444444444',
        mode: 'exclusive',
        rateBasisPoints: 1500,
        revision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      }
    })

    expect(store.addProduct(taxed)).toBe(false)
    expect(store.lines).toHaveLength(1)
    expect(store.calculation.grandTotalAmount).toBe(1000)
    expect(store.error).toBe('Products with different tax modes cannot share this cart.')
    i18n.global.locale.value = 'ar'
    expect(store.error).toBe('لا يمكن جمع منتجات ذات أوضاع ضريبية مختلفة في هذه السلة.')
  })

  it('clears an unsaved draft when a different catalog revision is installed', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    store.setContract({
      ...contract,
      revision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    })

    expect(store.lines).toEqual([])
    expect(store.error).toBe('The catalog changed, so the previous unsaved draft was cleared.')
  })
})
