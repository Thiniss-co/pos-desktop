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
    expect(store.error).toBe(
      "This register's catalog does not allow different tax modes in one sale. Refresh workstation data; if this stays, the server has not enabled mixed-tax sales."
    )
    i18n.global.locale.value = 'ar'
    expect(store.error).toBe(
      'كتالوج هذه النقطة لا يسمح بأوضاع ضريبية مختلفة في عملية بيع واحدة. حدّث بيانات محطة العمل؛ وإن استمر ذلك فالخادم لم يفعّل البيع بضرائب مختلفة.'
    )
  })

  it('keeps every line of a mixed-tax cart under a per_line contract through each cart action', () => {
    const perLine: CatalogContract = { ...contract, mixedTaxModePolicy: 'per_line' }
    const untaxed = product()
    const inclusive = product({
      uuid: '55555555-5555-4555-8555-555555555555',
      price: { ...product().price, amount: 1150 },
      tax: {
        id: '66666666-6666-4666-8666-666666666666',
        mode: 'inclusive',
        rateBasisPoints: 1500,
        revision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      }
    })
    const exclusive = product({
      uuid: '77777777-7777-4777-8777-777777777777',
      tax: {
        id: '88888888-8888-4888-8888-888888888888',
        mode: 'exclusive',
        rateBasisPoints: 500,
        revision: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      }
    })
    const store = useCartStore()
    store.setContract(perLine)

    // Either order is one cart; each line keeps its own mode and rate.
    for (const order of [
      [untaxed, inclusive, exclusive],
      [exclusive, inclusive, untaxed]
    ]) {
      store.clear()
      for (const item of order) expect(store.addProduct(item)).toBe(true)
      expect(store.error).toBeNull()
      expect(store.lines.map((line) => line.product.tax.mode)).toEqual(
        order.map((item) => item.tax.mode)
      )
      // 10.00 untaxed + 11.50 incl. (1.50 VAT) + 10.00 + 0.50 excl. VAT.
      expect(store.calculation?.taxTotalAmount).toBe(200)
      expect(store.calculation?.grandTotalAmount).toBe(3200)
    }

    const exclusiveLine = store.lines.find((line) => line.product.uuid === exclusive.uuid)!
    expect(store.incrementQuantity(exclusiveLine.id)).toBe(true)
    expect(store.calculation?.taxTotalAmount).toBe(250)
    expect(store.calculation?.grandTotalAmount).toBe(4250)

    const untaxedLine = store.lines.find((line) => line.product.uuid === untaxed.uuid)!
    expect(store.remove(untaxedLine.id)).toBe(true)
    expect(store.calculation?.grandTotalAmount).toBe(3250)

    const held = store.holdDraft()
    expect(held?.grandTotalAmount).toBe(3250)
    expect(store.lines).toHaveLength(0)
    expect(store.recallDraft(held!.id)).not.toBeNull()
    expect(store.error).toBeNull()
    expect(store.lines.map((line) => line.product.tax.mode)).toEqual(['exclusive', 'inclusive'])
    expect(store.calculation?.taxTotalAmount).toBe(250)
    expect(store.calculation?.grandTotalAmount).toBe(3250)
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

  it('re-applying the same new contract (a page remount) never un-flags the frozen draft', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    const next = {
      ...contract,
      revision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    }
    store.setContract(next)
    store.setContract(next)

    expect(store.catalogChanged).toBe(true)
    expect(store.cartState.kind).toBe('invalid')
    expect(store.lines).toHaveLength(1)
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

describe('useCartStore — POS reliability rev 3 (sale identity, attempt lock, revisions)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('re-mints the sale identity whenever the draft is replaced, including removing the last line', () => {
    const store = useCartStore()
    store.setContract(contract)
    const initial = store.saleId
    store.addProduct(product())
    expect(store.saleId).toBe(initial)
    store.remove(store.lines[0].id)
    expect(store.saleId).not.toBe(initial)
    const afterRemove = store.saleId
    store.addProduct(product())
    store.clear()
    expect(store.saleId).not.toBe(afterRemove)
  })

  it('refuses every draft mutation while a protected payment attempt is bound', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    store.setLocked(true)
    const line = store.lines[0].id

    expect(store.addProduct(product())).toBe(false)
    expect(store.incrementQuantity(line)).toBe(false)
    expect(store.remove(line)).toBe(false)
    expect(store.setInvoiceDiscount('fixed', 100)).toBe(false)
    expect(store.holdDraft()).toBeNull()
    expect(store.lines).toHaveLength(1)
    expect(store.error).toContain('payment')

    store.setLocked(false)
    expect(store.incrementQuantity(line)).toBe(true)
  })

  it('never stamps a product read under another catalog install onto this draft', () => {
    const store = useCartStore()
    store.setContract(contract)
    expect(store.addProduct(product(), 1000, 'f'.repeat(64))).toBe(false)
    expect(store.lines).toHaveLength(0)
    expect(store.addProduct(product(), 1000, contract.revision)).toBe(true)
  })

  it('drops removed products on rebuild only when the cashier confirmed them', () => {
    const store = useCartStore()
    store.setContract(contract)
    store.addProduct(product())
    store.addProduct(product({ uuid: '33333333-3333-4333-8333-333333333333', name: 'Gone' }))
    const gone = store.lines[1].id
    store.setContract({ ...contract, revision: 'd'.repeat(64) })
    expect(store.catalogChanged).toBe(true)

    // Without the explicit drop, a missing product keeps the draft blocked.
    expect(store.rebuildFromCatalog([product()])).toBe(false)
    expect(store.rebuildFromCatalog([product()], { dropLineIds: [gone] })).toBe(true)
    expect(store.lines.map((line) => line.product.name)).toEqual(['Water'])
    expect(store.lines[0].catalogRevision).toBe('d'.repeat(64))
  })
})
