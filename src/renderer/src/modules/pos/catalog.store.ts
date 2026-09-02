import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogRefreshResult,
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
  const isRefreshing = ref(false)
  const lastRefreshedAt = ref<string | null>(null)
  const lastRefreshRevisionChanged = ref(false)
  const refreshErrorState = createLocalizedErrorRef()
  const refreshError = refreshErrorState.error
  let latestSearch = 0
  let latestRefresh = 0

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

  /**
   * The authoritative "refresh workstation data" action behind the stale-catalog warning.
   *
   * Duplicate requests are refused rather than queued: while one refresh is in flight a second
   * call returns immediately without a second IPC round trip, so a double-click (or a click plus
   * an automatic retry) can never publish two snapshots or two conflicting result states.
   *
   * Main persists the whole snapshot in one transaction; this action then reloads every cached
   * view — status, categories, payment methods, products, customers — from that already-committed
   * snapshot, and assigns them together so the UI never renders a half-old/half-new catalogue.
   * A reply that is superseded while in flight (a newer refresh, or `resetCatalog()` on a session
   * change) is dropped and must never repopulate state for whoever the owner is now.
   *
   * It deliberately does not touch the cart. `revisionChanged` is recorded for the page, which
   * routes it into the existing explicit rebuild-or-clear flow — a refresh never reprices a draft.
   */
  async function refresh(
    service = new CatalogRendererService()
  ): Promise<CatalogRefreshResult | null> {
    if (isRefreshing.value) {
      return null
    }

    const request = ++latestRefresh
    isRefreshing.value = true
    refreshErrorState.clear()

    try {
      const result = await service.refresh()

      if (request !== latestRefresh) {
        return null
      }

      const [nextCategories, nextPaymentMethods] = result.status.isReadable
        ? await Promise.all([service.listCategories(), service.listPaymentMethods()])
        : [[], []]

      if (request !== latestRefresh) {
        return null
      }

      status.value = result.status
      categories.value = nextCategories
      paymentMethods.value = nextPaymentMethods
      lastRefreshedAt.value = result.refreshedAt
      lastRefreshRevisionChanged.value = result.revisionChanged

      if (!result.status.isReadable) {
        products.value = []
        customers.value = []
        total.value = 0
        return result
      }

      errorState.clear()
      await search(service)
      await searchCustomers(service)

      return request === latestRefresh ? result : null
    } catch (cause) {
      if (request !== latestRefresh) {
        return null
      }

      const publicError = parsePublicAppError(cause)

      if (publicError) {
        void handleSessionTransition(publicError)
        refreshErrorState.setDetail(publicError)
      } else {
        refreshErrorState.setFallbackKey('pos.catalogRefresh.failed')
      }

      return null
    } finally {
      if (request === latestRefresh) {
        isRefreshing.value = false
      }
    }
  }

  /**
   * Invalidates any in-flight refresh reply. Called when the owner context changes (logout,
   * cashier switch, device recovery) so a late reply cannot repopulate another owner's catalogue.
   */
  function resetCatalog(): void {
    latestRefresh += 1
    latestSearch += 1
    isRefreshing.value = false
    refreshErrorState.clear()
    lastRefreshedAt.value = null
    lastRefreshRevisionChanged.value = false
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
    isRefreshing,
    lastRefreshedAt,
    lastRefreshRevisionChanged,
    refreshError,
    refresh,
    resetCatalog,
    initialize,
    search,
    selectCategory,
    getProduct,
    findProductByBarcode,
    searchCustomers,
    selectCustomer
  }
})
