import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogStatus
} from '@shared/contracts/catalog.contract'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { CatalogRendererService } from './catalog.service'

const PAGE_SIZE = 24

export const useCatalogStore = defineStore('catalog', () => {
  const status = ref<CatalogStatus | null>(null)
  const categories = ref<CatalogCategory[]>([])
  const products = ref<CatalogProduct[]>([])
  const paymentMethods = ref<CatalogPaymentMethod[]>([])
  const customers = ref<CatalogCustomer[]>([])
  const customerQuery = ref('')
  const selectedCustomerUuid = ref<string | null>(null)
  const query = ref('')
  const selectedCategoryUuid = ref<string | null>(null)
  const total = ref(0)
  const isLoading = ref(false)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  let latestSearch = 0

  const isAvailable = computed(() => status.value?.isReadable === true)

  function setError(cause: unknown, fallbackKey: string): void {
    const publicError = parsePublicAppError(cause)

    if (publicError) {
      void handleSessionTransition(publicError)
      errorState.setDetail(publicError)
    } else {
      errorState.setFallbackKey(fallbackKey)
    }
  }

  async function initialize(service = new CatalogRendererService()): Promise<void> {
    errorState.clear()

    try {
      status.value = await service.getStatus()

      if (!status.value.isReadable) {
        categories.value = []
        products.value = []
        paymentMethods.value = []
        customers.value = []
        total.value = 0
        return
      }

      const [nextCategories, nextPaymentMethods] = await Promise.all([
        service.listCategories(),
        service.listPaymentMethods()
      ])
      categories.value = nextCategories
      paymentMethods.value = nextPaymentMethods
      await search(service)
      await searchCustomers(service)
    } catch (cause) {
      setError(cause, 'pos.catalogUnavailable')
    }
  }

  async function search(service = new CatalogRendererService()): Promise<void> {
    const request = ++latestSearch
    isLoading.value = true
    errorState.clear()

    try {
      const page = await service.searchProducts({
        query: query.value,
        categoryUuid: selectedCategoryUuid.value,
        limit: PAGE_SIZE,
        offset: 0
      })

      if (request !== latestSearch) {
        return
      }

      products.value = page.items
      total.value = page.total
    } catch (cause) {
      if (request === latestSearch) {
        setError(cause, 'pos.catalogUnavailable')
      }
    } finally {
      if (request === latestSearch) {
        isLoading.value = false
      }
    }
  }

  async function selectCategory(
    categoryUuid: string | null,
    service = new CatalogRendererService()
  ): Promise<void> {
    selectedCategoryUuid.value = categoryUuid
    await search(service)
  }

  async function findProductByBarcode(
    barcode: string,
    service = new CatalogRendererService()
  ): Promise<CatalogBarcodeLookup> {
    try {
      const result = await service.findProductByBarcode(barcode)
      errorState.clear()
      return result
    } catch (cause) {
      setError(cause, 'pos.barcodeNotFound')
      return { outcome: 'unavailable-catalog' }
    }
  }

  async function searchCustomers(service = new CatalogRendererService()): Promise<void> {
    try {
      const page = await service.searchCustomers({
        query: customerQuery.value,
        limit: PAGE_SIZE,
        offset: 0
      })
      customers.value = page.items
    } catch (cause) {
      setError(cause, 'pos.catalogUnavailable')
    }
  }

  function selectCustomer(uuid: string | null): void {
    selectedCustomerUuid.value = uuid
  }

  async function getProduct(
    uuid: string,
    service = new CatalogRendererService()
  ): Promise<CatalogProduct | null> {
    try {
      const product = await service.getProduct(uuid)
      errorState.clear()
      return product
    } catch (cause) {
      setError(cause, 'pos.catalogUnavailable')
      return null
    }
  }

  return {
    status,
    categories,
    products,
    paymentMethods,
    customers,
    customerQuery,
    selectedCustomerUuid,
    query,
    selectedCategoryUuid,
    total,
    isLoading,
    isAvailable,
    error,
    initialize,
    search,
    selectCategory,
    getProduct,
    findProductByBarcode,
    searchCustomers,
    selectCustomer
  }
})
