import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'
import { i18n } from '@renderer/i18n'
import { MAX_HELD_DRAFTS, useCartStore } from './cart.store'

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
    expect(store.calculation?.grandTotalAmount).toBe(1000)
    expect(store.error).toBe('Products with different tax modes cannot share this cart.')
    i18n.global.locale.value = 'ar'
    expect(store.error).toBe('لا يمكن جمع منتجات ذات أوضاع ضريبية مختلفة في هذه السلة.')
  })

  it('retains a frozen draft and marks it catalog-changed when a new revision is installed', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    store.setContract({
      ...contract,
      revision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    })

    expect(store.lines).toHaveLength(1)
    expect(store.cartState.kind).toBe('invalid')
    expect(store.error).toBe(
      'The catalog changed. Clear, remove, or explicitly rebuild this draft.'
    )
  })

  it('clears the invoice discount when the final line is removed', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())

    expect(store.setInvoiceDiscount('fixed', 1000)).toBe(true)
    expect(store.remove(store.lines[0]!.id)).toBe(true)
    expect(store.lines).toEqual([])
    expect(store.invoiceDiscountType).toBeNull()
    expect(store.invoiceDiscountValue).toBe(0)
  })

  it('blocks commercial mutations while a stale catalog remains readable', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    const lineId = store.lines[0]!.id

    store.setCatalogValidity(false)

    expect(store.incrementQuantity(lineId)).toBe(false)
    expect(store.setInvoiceDiscount('fixed', 100)).toBe(false)
    expect(store.addProduct(product())).toBe(false)
    expect(store.lines[0]?.quantity).toBe('1.000')
    expect(store.remove(lineId)).toBe(true)
    expect(store.lines).toEqual([])
  })

  it('explicitly resets a draft before a store is recreated on the same Pinia instance', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    store.resetDraft('logout')
    store.$dispose()

    const recreated = useCartStore(pinia)
    expect(recreated.lines).toEqual([])
    expect(recreated.cartState).toEqual({ kind: 'empty' })
  })

  it('adds a scanned multiple in one step and merges it onto an identical line', () => {
    const store = useCartStore()
    store.setContract(contract)

    expect(store.addProduct(product(), 3000)).toBe(true)
    expect(store.addProduct(product(), 1500)).toBe(true)
    expect(store.lines).toHaveLength(1)
    expect(store.lines[0].quantity).toBe('4.500')
    expect(store.calculation?.grandTotalAmount).toBe(4500)

    expect(store.addProduct(product(), 0)).toBe(false)
    expect(store.addProduct(product(), 1.5)).toBe(false)
    expect(store.lines[0].quantity).toBe('4.500')
  })

  it('holds the live draft, clears the cart, and recalls it intact', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product(), 2000)
    store.setInvoiceDiscount('fixed', 100)

    const held = store.holdDraft({ uuid: 'customer-1', name: 'Mona' })
    expect(held).not.toBeNull()
    expect(held?.itemCount).toBe(1)
    expect(held?.grandTotalAmount).toBe(1900)
    expect(held?.customerName).toBe('Mona')
    expect(store.lines).toHaveLength(0)
    expect(store.cartState.kind).toBe('empty')
    expect(store.heldDrafts).toHaveLength(1)

    const recalled = store.recallDraft(held!.id)
    expect(recalled?.customerUuid).toBe('customer-1')
    expect(store.heldDrafts).toHaveLength(0)
    expect(store.lines[0].quantity).toBe('2.000')
    expect(store.invoiceDiscountType).toBe('fixed')
    expect(store.calculation?.grandTotalAmount).toBe(1900)
  })

  it('refuses to hold an empty cart and never merges a recall into a live draft', () => {
    const store = useCartStore()
    store.setContract(contract)
    expect(store.holdDraft()).toBeNull()

    store.addProduct(product())
    const held = store.holdDraft()!
    store.addProduct(product({ uuid: '33333333-3333-4333-8333-333333333333', name: 'Bread' }))

    expect(store.recallDraft(held.id)).toBeNull()
    expect(store.heldDrafts).toHaveLength(1)
    expect(store.lines.map((line) => line.product.name)).toEqual(['Bread'])
  })

  it('recalls a draft held under an older catalog revision as blocked, never repriced', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    const held = store.holdDraft()!

    store.setContract({ ...contract, revision: 'd'.repeat(64) })
    expect(store.recallDraft(held.id)).not.toBeNull()
    expect(store.cartState).toMatchObject({ kind: 'invalid', code: 'CART_CATALOG_CHANGED' })
    expect(store.canEdit).toBe(false)
    expect(store.lines[0].product.price.amount).toBe(1000)
  })

  it('discards held drafts on resetDraft and caps the held list', () => {
    const store = useCartStore()
    store.setContract(contract)

    for (let index = 0; index < MAX_HELD_DRAFTS; index += 1) {
      store.addProduct(product())
      expect(store.holdDraft()).not.toBeNull()
    }

    store.addProduct(product())
    expect(store.holdDraft()).toBeNull()
    expect(store.error).toBe(i18n.global.t('pos.errors.CART_HOLD_LIMIT'))
    expect(store.lines).toHaveLength(1)

    store.discardHeldDraft(store.heldDrafts[0].id)
    expect(store.heldDrafts).toHaveLength(MAX_HELD_DRAFTS - 1)

    store.resetDraft('logout')
    expect(store.heldDrafts).toHaveLength(0)
    expect(store.lines).toHaveLength(0)
  })
})
