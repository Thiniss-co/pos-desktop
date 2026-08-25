import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CatalogContract, CatalogProduct } from '@shared/contracts/catalog.contract'
import { i18n } from '@renderer/i18n'
import { addQuantity, calculateCart, CartDomainError, type CartCalculation } from './cartCalculator'

export interface CartLineSnapshot {
  readonly id: string
  readonly mergeKey: string
  readonly catalogRevision: string
  readonly product: CatalogProduct
  readonly quantity: string
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
  const errorCode = ref<string | null>(null)
  const error = computed(() =>
    errorCode.value ? String(i18n.global.t(`pos.errors.${errorCode.value}`)) : null
  )
  const calculation = computed<CartCalculation>(() => {
    if (!contract.value || lines.value.length === 0) {
      return {
        lines: [],
        subtotalAmount: 0,
        discountTotalAmount: 0,
        taxTotalAmount: 0,
        grandTotalAmount: 0
      }
    }

    return calculateCart(
      lines.value.map((line) => ({
        id: line.id,
        quantity: line.quantity,
        unitPriceAmount: line.product.price.amount,
        currency: line.product.price.currency,
        taxMode: line.product.tax.mode,
        taxRateBasisPoints: line.product.tax.rateBasisPoints
      })),
      contract.value
    )
  })

  function setContract(next: CatalogContract): void {
    if (contract.value && contract.value.revision !== next.revision && lines.value.length > 0) {
      lines.value = []
      errorCode.value = 'CART_CATALOG_CHANGED'
    }

    contract.value = next
  }

  function apply(operation: () => void): boolean {
    errorCode.value = null

    try {
      operation()
      void calculation.value
      return true
    } catch (cause) {
      if (cause instanceof CartDomainError) {
        errorCode.value = cause.code
      } else {
        errorCode.value = 'CART_INVALID'
      }
      return false
    }
  }

  function addProduct(product: CatalogProduct): boolean {
    if (!contract.value) {
      errorCode.value = 'CART_CATALOG_REQUIRED'
      return false
    }

    const catalogRevision = contract.value.revision
    const key = mergeKey(product, catalogRevision)
    const existing = lines.value.find((line) => line.mergeKey === key)
    const previous = lines.value

    return apply(() => {
      if (existing) {
        lines.value = lines.value.map((line) =>
          line.id === existing.id
            ? { ...line, quantity: addQuantity(line.quantity, 1000n, contract.value!) }
            : line
        )
      } else {
        const snapshot = immutableProductSnapshot(product)
        lines.value = [
          ...lines.value,
          {
            id: crypto.randomUUID(),
            mergeKey: key,
            catalogRevision,
            product: snapshot,
            quantity: '1.000'
          }
        ]
      }

      try {
        void calculation.value
      } catch (cause) {
        lines.value = previous
        throw cause
      }
    })
  }

  function changeQuantity(id: string, deltaMilli: bigint): boolean {
    if (!contract.value) {
      return false
    }

    const previous = lines.value
    return apply(() => {
      lines.value = lines.value.map((line) =>
        line.id === id
          ? { ...line, quantity: addQuantity(line.quantity, deltaMilli, contract.value!) }
          : line
      )

      try {
        void calculation.value
      } catch (cause) {
        lines.value = previous
        throw cause
      }
    })
  }

  function remove(id: string): void {
    lines.value = lines.value.filter((line) => line.id !== id)
    errorCode.value = null
  }

  function clear(): void {
    lines.value = []
    errorCode.value = null
  }

  return {
    lines,
    contract,
    calculation,
    error,
    setContract,
    addProduct,
    changeQuantity,
    remove,
    clear
  }
})
