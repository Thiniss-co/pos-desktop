import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'
import {
  addQuantity,
  calculateCart,
  type CartCalculation,
  type CartCalculationErrorCode,
  type DiscountType
} from '@shared/pos/posCalculator'
import { i18n } from '@renderer/i18n'

export interface CartLineSnapshot {
  readonly id: string
  readonly mergeKey: string
  readonly catalogRevision: string
  readonly product: CatalogProduct
  readonly quantity: string
  readonly discountType: DiscountType
  readonly discountValue: number
}

export type CartState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly totals: CartCalculation }
  | {
      readonly kind: 'invalid'
      readonly code: CartCalculationErrorCode
      readonly lastValid?: CartCalculation
    }

function mergeKey(product: CatalogProduct, catalogRevision: string): string {
  return [
    catalogRevision,
    product.uuid,
    product.price.currency,
    product.price.amount,
    product.price.revision,
    product.tax.id ?? '',
    product.tax.mode,
    product.tax.rateBasisPoints,
    product.tax.revision
  ].join('|')
}

function immutableProductSnapshot(product: CatalogProduct): CatalogProduct {
  return Object.freeze({
    ...product,
    price: Object.freeze({ ...product.price }),
    tax: Object.freeze({ ...product.tax })
  })
}

export const useCartStore = defineStore('cart', () => {
  const lines = ref<CartLineSnapshot[]>([])
  const contract = ref<CatalogContract | null>(null)
  const cartState = ref<CartState>({ kind: 'empty' })
  const invoiceDiscountType = ref<DiscountType>(null)
  const invoiceDiscountValue = ref(0)
  const catalogValid = ref(false)
  const catalogChanged = ref(false)
  const contextGeneration = ref(0)
  const draftRevision = ref(0)
  const catalogGeneration = ref(0)
  const lastValid = ref<CartCalculation | null>(null)
  const rejectionCode = ref<CartCalculationErrorCode | null>(null)

  const error = computed(() =>
    rejectionCode.value ? String(i18n.global.t(`pos.errors.${rejectionCode.value}`)) : null
  )
  const calculation = computed(() => {
    if (cartState.value.kind === 'valid') {
      return cartState.value.totals
    }

    return cartState.value.kind === 'invalid' ? (cartState.value.lastValid ?? null) : null
  })
  const canEdit = computed(
    () => contract.value !== null && catalogValid.value && catalogChanged.value === false
  )

  function reject(code: CartCalculationErrorCode): false {
    rejectionCode.value = code
    return false
  }

  function markInvalid(code: CartCalculationErrorCode): void {
    cartState.value = {
      kind: 'invalid',
      code,
      ...(lastValid.value ? { lastValid: lastValid.value } : {})
    }
    rejectionCode.value = code
  }

  function candidate(
    nextLines: readonly CartLineSnapshot[],
    nextInvoiceDiscountType = invoiceDiscountType.value,
    nextInvoiceDiscountValue = invoiceDiscountValue.value
  ): CartState {
    if (!contract.value) {
      return { kind: 'invalid', code: 'CART_CATALOG_REQUIRED' }
    }

    if (nextLines.length === 0) {
      return { kind: 'empty' }
    }

    const result = calculateCart(
      nextLines.map((line) => ({
        id: line.id,
        productUuid: line.product.uuid,
        quantity: line.quantity,
        unitPriceAmount: line.product.price.amount,
        currency: line.product.price.currency,
        discountType: line.discountType,
        discountValue: line.discountValue,
        taxMode: line.product.tax.mode,
        taxRateBasisPoints: line.product.tax.rateBasisPoints
      })),
      contract.value,
      nextInvoiceDiscountType,
      nextInvoiceDiscountValue
    )

    return result.ok
      ? { kind: 'valid', totals: result.value }
      : { kind: 'invalid', code: result.code }
  }

  function commit(
    nextLines: CartLineSnapshot[],
    nextInvoiceDiscountType = invoiceDiscountType.value,
    nextInvoiceDiscountValue = invoiceDiscountValue.value
  ): boolean {
    const next = candidate(nextLines, nextInvoiceDiscountType, nextInvoiceDiscountValue)

    if (next.kind === 'invalid') {
      return reject(next.code)
    }

    lines.value = nextLines
    invoiceDiscountType.value = nextInvoiceDiscountType
    invoiceDiscountValue.value = nextInvoiceDiscountValue
    cartState.value = next
    if (next.kind === 'valid') {
      lastValid.value = next.totals
    }
    rejectionCode.value = null
    draftRevision.value += 1
    return true
  }

  function setContract(nextContract: CatalogContract): void {
    const revisionChanged =
      contract.value?.revision !== undefined && contract.value.revision !== nextContract.revision
    contract.value = nextContract
    catalogValid.value = true

    if (revisionChanged) {
      catalogGeneration.value += 1
    }

    if (revisionChanged && lines.value.length > 0) {
      // Frozen snapshots remain visible until the cashier explicitly clears, removes, or rebuilds.
      // Repricing a draft on catalog refresh would silently change a commercial transaction.
      catalogChanged.value = true
      markInvalid('CART_CATALOG_CHANGED')
      return
    }

    catalogChanged.value = false
    if (lines.value.length === 0) {
      cartState.value = { kind: 'empty' }
      rejectionCode.value = null
      return
    }

    const evaluated = candidate(lines.value)
    if (evaluated.kind === 'valid') {
      cartState.value = evaluated
      lastValid.value = evaluated.totals
      rejectionCode.value = null
    } else if (evaluated.kind === 'invalid') {
      markInvalid(evaluated.code)
    }
  }

  /**
   * Catalog reads remain available while stale, but commercial draft mutations do not. This is
   * deliberately distinct from a revision change: stale drafts may still be removed or cleared.
   */
  function setCatalogValidity(isValid: boolean): void {
    catalogValid.value = isValid
  }

  function addProduct(product: CatalogProduct): boolean {
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }
    if (product.price.currency !== contract.value.currency) {
      return reject('CART_MIXED_CURRENCY')
    }

    const key = mergeKey(product, contract.value.revision)
    const existing = lines.value.find((line) => line.mergeKey === key)

    if (existing) {
      const nextQuantity = addQuantity(existing.quantity, 1000, contract.value)
      if (!nextQuantity.ok) {
        return reject(nextQuantity.code)
      }

      return commit(
        lines.value.map((line) =>
          line.id === existing.id ? { ...line, quantity: nextQuantity.value } : line
        )
      )
    }

    return commit([
      ...lines.value,
      {
        id: crypto.randomUUID(),
        mergeKey: key,
        catalogRevision: contract.value.revision,
        product: immutableProductSnapshot(product),
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      }
    ])
  }

  function changeQuantity(id: string, deltaMilli: number): boolean {
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }

    const current = lines.value.find((line) => line.id === id)
    if (!current) {
      return reject('CART_INVALID')
    }

    const nextQuantity = addQuantity(current.quantity, deltaMilli, contract.value)
    if (!nextQuantity.ok) {
      return reject(nextQuantity.code)
    }

    return commit(
      lines.value.map((line) => (line.id === id ? { ...line, quantity: nextQuantity.value } : line))
    )
  }

  function incrementQuantity(id: string): boolean {
    return changeQuantity(id, 1000)
  }

  function decrementQuantity(id: string): boolean {
    return changeQuantity(id, -1000)
  }

  function setQuantity(id: string, quantity: string): boolean {
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (catalogChanged.value) {
      return reject('CART_CATALOG_CHANGED')
    }
    if (!lines.value.some((line) => line.id === id)) {
      return reject('CART_INVALID')
    }

    return commit(lines.value.map((line) => (line.id === id ? { ...line, quantity } : line)))
  }

  function setLineDiscount(id: string, type: DiscountType, value: number): boolean {
    if (!canEdit.value) {
      return reject(catalogChanged.value ? 'CART_CATALOG_CHANGED' : 'CART_CATALOG_REQUIRED')
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      return reject('CART_DISCOUNT_INVALID')
    }

    return commit(
      lines.value.map((line) =>
        line.id === id ? { ...line, discountType: type, discountValue: value } : line
      )
    )
  }

  function setInvoiceDiscount(type: DiscountType, value: number): boolean {
    if (!canEdit.value) {
      return reject(catalogChanged.value ? 'CART_CATALOG_CHANGED' : 'CART_CATALOG_REQUIRED')
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      return reject('CART_DISCOUNT_INVALID')
    }

    return commit([...lines.value], type, value)
  }

  function remove(id: string): boolean {
    const nextLines = lines.value.filter((line) => line.id !== id)
    if (nextLines.length === lines.value.length) {
      return false
    }

    if (nextLines.length === 0) {
      clear()
      return true
    }

    if (catalogChanged.value) {
      // Do not calculate old snapshots against the new contract. The draft stays blocked until
      // the cashier has explicitly rebuilt it, even after removing an obsolete line.
      lines.value = nextLines
      if (nextLines.length === 0) {
        clear()
      } else {
        markInvalid('CART_CATALOG_CHANGED')
        draftRevision.value += 1
      }
      return true
    }

    // Candidate validation leaves an invalid fixed-discount draft untouched for explicit
    // resolution through the line or invoice discount actions.
    return commit(nextLines)
  }

  function clear(): void {
    lines.value = []
    invoiceDiscountType.value = null
    invoiceDiscountValue.value = 0
    catalogChanged.value = false
    lastValid.value = null
    cartState.value = { kind: 'empty' }
    rejectionCode.value = null
    draftRevision.value += 1
  }

  /** Reset transient draft state on logout, session revocation, device recovery, or shift/company change. */
  function resetDraft(reason?: string): void {
    void reason
    contextGeneration.value += 1
    clear()
  }

  function captureContext(): string {
    return `${contextGeneration.value}:${draftRevision.value}:${catalogGeneration.value}`
  }

  function isCurrentContext(token: string): boolean {
    return token === captureContext()
  }

  /**
   * Explicit cashier action only. The caller resolves every frozen product against the newly
   * installed catalog; a missing or invalid replacement leaves the old snapshot untouched.
   */
  function rebuildFromCatalog(products: readonly CatalogProduct[]): boolean {
    if (!contract.value || !catalogValid.value) {
      return reject('CART_CATALOG_REQUIRED')
    }
    if (!catalogChanged.value) {
      return false
    }

    const byUuid = new Map(products.map((product) => [product.uuid, product]))
    const replacements: CartLineSnapshot[] = []

    for (const line of lines.value) {
      const product = byUuid.get(line.product.uuid)
      if (!product || product.price.currency !== contract.value.currency) {
        return reject('CART_CATALOG_CHANGED')
      }

      replacements.push({
        ...line,
        mergeKey: mergeKey(product, contract.value.revision),
        catalogRevision: contract.value.revision,
        product: immutableProductSnapshot(product)
      })
    }

    catalogChanged.value = false
    const committed = commit(replacements)
    if (!committed) {
      catalogChanged.value = true
    }
    return committed
  }

  return {
    lines,
    contract,
    cartState,
    calculation,
    error,
    canEdit,
    catalogChanged,
    invoiceDiscountType,
    invoiceDiscountValue,
    catalogValid,
    contextGeneration,
    draftRevision,
    catalogGeneration,
    setContract,
    setCatalogValidity,
    addProduct,
    changeQuantity,
    incrementQuantity,
    decrementQuantity,
    setQuantity,
    setLineDiscount,
    setInvoiceDiscount,
    remove,
    clear,
    resetDraft,
    captureContext,
    isCurrentContext,
    rebuildFromCatalog
  }
})
