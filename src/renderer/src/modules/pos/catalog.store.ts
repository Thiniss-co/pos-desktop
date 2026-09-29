import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CatalogCategory,
  CatalogBarcodeLookup,
  CatalogCustomer,
  CatalogPaymentMethod,
  CatalogProduct,
  CatalogProductForSale,
  CatalogRefreshResult,
  CatalogStatus,
  ProductStockView
} from '@shared/contracts/catalog.contract'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { CatalogRendererService, type CatalogChange } from './catalog.service'

const PAGE_SIZE = 24
/** Page sizes the POS catalog grid offers (V3 "Items per page"). */
export const CATALOG_PAGE_SIZES = [12, 24] as const
export type CatalogPageSize = (typeof CATALOG_PAGE_SIZES)[number]

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
  /** Zero-based page of the current search; any new search or filter starts again at 0. */
  const page = ref(0)
  const pageSize = ref<CatalogPageSize>(PAGE_SIZE)
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
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
  let latestInit = 0
  let latestCustomerSearch = 0
  /**
   * POS reliability rev 3: bumped whenever main reports a newly installed snapshot and on owner
   * reset. Every async read captures it; a result from an older generation is never displayed.
   */
  const generation = ref(0)
  /** Separated stock information for the products currently shown (keyed by product uuid). */
  const stock = ref<Record<string, ProductStockView>>({})
  /** The catalog revision the currently shown product page was read under. */
  const pageRevision = ref<string | null>(null)
  let subscriptionHolders = 0
  let mismatchRevisionRetried: string | null = null
  let unsubscribeChanges: (() => void) | null = null

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
    const request = ++latestInit
    const issuedGeneration = generation.value
    const current = (): boolean => request === latestInit && issuedGeneration === generation.value
    errorState.clear()

    try {
      const nextStatus = await service.getStatus()
      if (!current()) {
        return
      }
      status.value = nextStatus

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
      if (!current()) {
        return
      }
      categories.value = nextCategories
      paymentMethods.value = nextPaymentMethods
      await search(service)
      await searchCustomers(service)
    } catch (cause) {
      if (current()) {
        setError(cause, 'pos.catalogUnavailable')
      }
    }
  }

  /** A new search (query or category) always starts on the first page. */
  async function search(service = new CatalogRendererService()): Promise<void> {
    page.value = 0
    await fetchPage(service)
  }

  /** Moves within the current search; out-of-range pages clamp to the first/last page. */
  async function goToPage(next: number, service = new CatalogRendererService()): Promise<void> {
    page.value = Math.min(Math.max(0, Math.trunc(next)), pageCount.value - 1)
    await fetchPage(service)
  }

  async function setPageSize(
    size: CatalogPageSize,
    service = new CatalogRendererService()
  ): Promise<void> {
    if (!CATALOG_PAGE_SIZES.includes(size)) {
      return
    }
    pageSize.value = size
    page.value = 0
    await fetchPage(service)
  }

  async function fetchPage(
    service: CatalogRendererService,
    options: { readonly silent?: boolean } = {}
  ): Promise<void> {
    const request = ++latestSearch
    const issuedGeneration = generation.value
    if (!options.silent) {
      isLoading.value = true
    }
    errorState.clear()

    try {
      const result = await service.searchProducts({
        query: query.value,
        categoryUuid: selectedCategoryUuid.value,
        limit: pageSize.value,
        offset: page.value * pageSize.value
      })

      if (request !== latestSearch || issuedGeneration !== generation.value) {
        return
      }

      // Rows, contract and stock come from one read transaction in main. If they were read under a
      // different revision than the status this store holds, a snapshot was installed in between:
      // re-read the status instead of showing rows the cart would stamp with the wrong revision.
      if (status.value?.contract && result.contract.revision !== status.value.contract.revision) {
        if (mismatchRevisionRetried === result.contract.revision) {
          // The status was re-read once for this revision and still disagrees: never loop and
          // never display mixed rows — report the catalog as unavailable for this view.
          setError(null, 'pos.catalogUnavailable')
          return
        }
        mismatchRevisionRetried = result.contract.revision
        generation.value += 1
        void initialize(service)
        return
      }
      mismatchRevisionRetried = null

      const lastPage = Math.max(0, Math.ceil(result.total / pageSize.value) - 1)

      if (result.items.length === 0 && page.value > lastPage) {
        // The result set is smaller than the page asked for — the page index was clamped against
        // an older total (a racing search, or a catalog refresh). Show the last real page instead
        // of an empty grid past the end. Only ever moves to a page the new total supports, so it
        // re-requests at most once.
        total.value = result.total
        page.value = lastPage
        await fetchPage(service)
        return
      }

      products.value = result.items
      total.value = result.total
      stock.value = result.stock ?? {}
      pageRevision.value = result.contract.revision
    } catch (cause) {
      if (request === latestSearch && issuedGeneration === generation.value) {
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
      if (
        result.outcome === 'found' &&
        result.revision &&
        result.revision !== status.value?.contract?.revision
      ) {
        // Read under a newer install than this store knows: learn the new status first so the
        // caller compares the product against the contract it actually came from.
        generation.value += 1
        await initialize(service)
      }
      return result
    } catch (cause) {
      setError(cause, 'pos.barcodeNotFound')
      return { outcome: 'unavailable-catalog' }
    }
  }

  async function searchCustomers(service = new CatalogRendererService()): Promise<void> {
    const request = ++latestCustomerSearch
    const issuedGeneration = generation.value
    try {
      const page = await service.searchCustomers({
        query: customerQuery.value,
        limit: PAGE_SIZE,
        offset: 0
      })
      if (request === latestCustomerSearch && issuedGeneration === generation.value) {
        customers.value = page.items
      }
    } catch (cause) {
      if (request === latestCustomerSearch && issuedGeneration === generation.value) {
        setError(cause, 'pos.catalogUnavailable')
      }
    }
  }

  function selectCustomer(uuid: string | null): void {
    selectedCustomerUuid.value = uuid
  }

  /**
   * Rev 3: a product for the cart, with the revision it was read under. If that revision differs
   * from the status this store holds, the status is re-read first, so the caller never compares a
   * product with a contract from a different install.
   */
  async function getProductForSale(
    uuid: string,
    service = new CatalogRendererService()
  ): Promise<CatalogProductForSale | null> {
    try {
      const result = await service.getProductForSale(uuid)
      errorState.clear()
      if (result.revision !== status.value?.contract?.revision) {
        generation.value += 1
        await initialize(service)
      }
      return result
    } catch (cause) {
      setError(cause, 'pos.catalogUnavailable')
      return null
    }
  }

  /**
   * Rev 3: reference-counted subscription to main's change hints (sync store pattern). `stock`
   * re-reads the visible page in place from local data (no network); `snapshot` bumps the
   * generation and re-reads status and rows together.
   */
  function subscribeToChanges(service = new CatalogRendererService()): () => void {
    subscriptionHolders += 1
    if (!unsubscribeChanges) {
      unsubscribeChanges = service.onChanged((change: CatalogChange) => {
        if (change.reason === 'snapshot') {
          generation.value += 1
          void initialize(service)
          return
        }
        if (status.value?.isReadable) {
          void fetchPage(service, { silent: true })
        }
      })
    }

    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      subscriptionHolders = Math.max(0, subscriptionHolders - 1)
      if (subscriptionHolders === 0 && unsubscribeChanges) {
        unsubscribeChanges()
        unsubscribeChanges = null
      }
    }
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
    latestInit += 1
    latestCustomerSearch += 1
    generation.value += 1
    stock.value = {}
    pageRevision.value = null
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
    page,
    pageSize,
    pageCount,
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
    goToPage,
    setPageSize,
    selectCategory,
    getProduct,
    getProductForSale,
    subscribeToChanges,
    generation,
    stock,
    pageRevision,
    findProductByBarcode,
    searchCustomers,
    selectCustomer
  }
})
