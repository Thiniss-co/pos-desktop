import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CatalogContract, CatalogProductPage } from '@shared/contracts/catalog.contract'
import { CatalogRendererService } from './catalog.service'
import { useCatalogStore } from './catalog.store'

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

function page(total: number): CatalogProductPage {
  return { items: [], total, limit: 24, offset: 0, contract }
}

describe('useCatalogStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('discards stale search responses', async () => {
    const resolvers: Array<(value: CatalogProductPage) => void> = []
    const service = {
      searchProducts: () => new Promise<CatalogProductPage>((resolve) => resolvers.push(resolve))
    } as unknown as CatalogRendererService
    const store = useCatalogStore()
    const first = store.search(service)
    const second = store.search(service)
    resolvers[1](page(2))
    await second
    resolvers[0](page(1))
    await first

    expect(store.total).toBe(2)
    expect(store.isLoading).toBe(false)
  })

  describe('pagination', () => {
    function recordingService(total: number): {
      calls: Array<{ limit: number; offset: number; query: string }>
      service: CatalogRendererService
    } {
      const calls: Array<{ limit: number; offset: number; query: string }> = []
      const service = {
        searchProducts: async (input: { limit: number; offset: number; query: string }) => {
          calls.push({ limit: input.limit, offset: input.offset, query: input.query })
          return { items: [], total, limit: input.limit, offset: input.offset, contract }
        }
      } as unknown as CatalogRendererService
      return { calls, service }
    }

    it('pages through the current search with the existing limit/offset contract', async () => {
      const { calls, service } = recordingService(60)
      const store = useCatalogStore()

      await store.search(service)
      expect(calls.at(-1)).toMatchObject({ limit: 24, offset: 0 })
      expect(store.pageCount).toBe(3)

      await store.goToPage(2, service)
      expect(store.page).toBe(2)
      expect(calls.at(-1)).toMatchObject({ limit: 24, offset: 48 })

      // Out-of-range requests clamp instead of reading past the result set.
      await store.goToPage(9, service)
      expect(store.page).toBe(2)
      await store.goToPage(-1, service)
      expect(store.page).toBe(0)
    })

    it('restarts at the first page for a new search or page size', async () => {
      const { calls, service } = recordingService(60)
      const store = useCatalogStore()

      await store.search(service)
      await store.goToPage(1, service)
      await store.setPageSize(12, service)
      expect(store.page).toBe(0)
      expect(calls.at(-1)).toMatchObject({ limit: 12, offset: 0 })
      expect(store.pageCount).toBe(5)

      await store.goToPage(3, service)
      store.query = 'cola'
      await store.search(service)
      expect(store.page).toBe(0)
      expect(calls.at(-1)).toMatchObject({ limit: 12, offset: 0, query: 'cola' })
    })

    it('restarts at the first page when the category changes', async () => {
      const { calls, service } = recordingService(60)
      const store = useCatalogStore()

      await store.search(service)
      await store.goToPage(2, service)
      await store.selectCategory('cat-1', service)

      expect(store.page).toBe(0)
      expect(store.selectedCategoryUuid).toBe('cat-1')
      expect(calls.at(-1)).toMatchObject({ offset: 0 })
    })

    /** Resolves requests in whatever order the test chooses, and labels items by offset. */
    function deferredService(): {
      pending: Array<{ offset: number; query: string; resolve: (total: number) => void }>
      service: CatalogRendererService
    } {
      const pending: Array<{ offset: number; query: string; resolve: (total: number) => void }> = []
      const service = {
        searchProducts: (input: { limit: number; offset: number; query: string }) =>
          new Promise<CatalogProductPage>((resolve) => {
            pending.push({
              offset: input.offset,
              query: input.query,
              resolve: (total) =>
                resolve({
                  // Like the real repository: past the end of the result set, the page is empty.
                  items: (input.offset < total
                    ? [{ uuid: `${input.query}@${input.offset}` }]
                    : []) as never,
                  total,
                  limit: input.limit,
                  offset: input.offset,
                  contract
                })
            })
          })
      } as unknown as CatalogRendererService
      return { pending, service }
    }

    it('never shows an obsolete page when rapid page requests resolve out of order', async () => {
      const { pending, service } = deferredService()
      const store = useCatalogStore()
      const initial = store.search(service)
      pending[0].resolve(72)
      await initial

      const toPage1 = store.goToPage(1, service)
      const toPage2 = store.goToPage(2, service)
      pending[2].resolve(72)
      await toPage2
      pending[1].resolve(72)
      await toPage1

      expect(store.page).toBe(2)
      expect(store.products.map((item) => item.uuid)).toEqual(['@48'])
      expect(store.isLoading).toBe(false)
    })

    it('discards a page request that a newer search overtook', async () => {
      const { pending, service } = deferredService()
      const store = useCatalogStore()
      const initial = store.search(service)
      pending[0].resolve(72)
      await initial

      const toPage2 = store.goToPage(2, service)
      store.query = 'cola'
      const newSearch = store.search(service)
      pending[2].resolve(5)
      await newSearch
      pending[1].resolve(72)
      await toPage2

      expect(store.page).toBe(0)
      expect(store.total).toBe(5)
      expect(store.products.map((item) => item.uuid)).toEqual(['cola@0'])
    })

    it('falls back to the last real page when the result set shrank under the current page', async () => {
      const { pending, service } = deferredService()
      const store = useCatalogStore()
      const initial = store.search(service)
      pending[0].resolve(72)
      await initial

      // Page 2 of 3 was valid for 72 items, but the catalog now holds 30 (two pages of 24).
      const toPage2 = store.goToPage(2, service)
      pending[1].resolve(30)
      await vi.waitFor(() => expect(pending).toHaveLength(3))
      expect(pending[2].offset).toBe(24)
      pending[2].resolve(30)
      await toPage2

      expect(store.page).toBe(1)
      expect(store.pageCount).toBe(2)
      expect(store.products.map((item) => item.uuid)).toEqual(['@24'])
      expect(store.isLoading).toBe(false)
    })
  })

  describe('refresh', () => {
    const freshStatus = {
      status: 'fresh' as const,
      isReadable: true,
      catalogValid: true,
      lastSyncedAt: '2026-01-01T02:00:00Z',
      contract
    }

    const allowedAccess = {
      sell: { allowed: true, reason: null, warning: null, action: 'sell' as const },
      sync: { allowed: true, reason: null, warning: null, action: 'sync' as const }
    }

    function refreshResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        status: freshStatus,
        refreshedAt: '2026-01-01T02:00:00.000Z',
        previousRevision: null,
        revisionChanged: false,
        counts: {},
        access: allowedAccess,
        licenseValidatedAt: '2026-01-01T02:00:00+00:00',
        ...overrides
      }
    }

    function refreshService(overrides: Record<string, unknown> = {}): CatalogRendererService {
      return {
        refresh: async () => refreshResult(),
        listCategories: async () => [{ uuid: 'cat-1', name: 'Drinks' }],
        listPaymentMethods: async () => [
          { uuid: 'pm-1', name: 'Cash', code: 'cash', type: 'cash' }
        ],
        searchProducts: async () => page(4),
        searchCustomers: async () => ({ items: [], total: 0, limit: 24, offset: 0 }),
        ...overrides
      } as unknown as CatalogRendererService
    }

    it('replaces status, categories, payment methods and products from one refresh', async () => {
      const store = useCatalogStore()

      const result = await store.refresh(refreshService())

      expect(result?.refreshedAt).toBe('2026-01-01T02:00:00.000Z')
      expect(store.status).toEqual(freshStatus)
      expect(store.categories).toHaveLength(1)
      expect(store.paymentMethods).toHaveLength(1)
      expect(store.total).toBe(4)
      expect(store.lastRefreshedAt).toBe('2026-01-01T02:00:00.000Z')
      expect(store.refreshError).toBeNull()
      expect(store.isRefreshing).toBe(false)
    })

    it('refuses a duplicate refresh while one is already in flight', async () => {
      let calls = 0
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const service = refreshService({
        refresh: async () => {
          calls += 1
          await gate
          return refreshResult()
        }
      })
      const store = useCatalogStore()

      const first = store.refresh(service)
      // A second click while the first is still running must not start a second request.
      const second = await store.refresh(service)

      expect(second).toBeNull()
      expect(store.isRefreshing).toBe(true)
      release?.()
      await first

      expect(calls).toBe(1)
      expect(store.isRefreshing).toBe(false)
    })

    it('allows a new refresh once the previous one settled', async () => {
      let calls = 0
      const service = refreshService({
        refresh: async () => {
          calls += 1
          return refreshResult()
        }
      })
      const store = useCatalogStore()

      await store.refresh(service)
      await store.refresh(service)

      expect(calls).toBe(2)
    })

    it('records an actionable error and keeps the previous catalog readable', async () => {
      const store = useCatalogStore()
      store.status = freshStatus

      const result = await store.refresh(
        refreshService({
          refresh: async () => {
            throw new Error('offline')
          }
        })
      )

      expect(result).toBeNull()
      expect(store.refreshError).not.toBeNull()
      expect(store.isRefreshing).toBe(false)
      // The refresh failed; the cashier keeps selling against the catalog they already had.
      expect(store.status).toEqual(freshStatus)
    })

    it('clears a previous refresh error when a later refresh succeeds', async () => {
      const store = useCatalogStore()
      await store.refresh(
        refreshService({
          refresh: async () => {
            throw new Error('offline')
          }
        })
      )
      expect(store.refreshError).not.toBeNull()

      await store.refresh(refreshService())

      expect(store.refreshError).toBeNull()
    })

    it('reports a changed revision so the page can require a rebuild or clear', async () => {
      const store = useCatalogStore()

      const result = await store.refresh(
        refreshService({
          refresh: async () =>
            refreshResult({ previousRevision: 'b'.repeat(64), revisionChanged: true })
        })
      )

      expect(result?.revisionChanged).toBe(true)
      expect(store.lastRefreshRevisionChanged).toBe(true)
    })

    it('empties the cached views when the refreshed catalog is not readable', async () => {
      const store = useCatalogStore()
      store.products = [{ uuid: 'stale-product' }] as never
      store.total = 9

      await store.refresh(
        refreshService({
          refresh: async () =>
            refreshResult({
              status: {
                status: 'unavailable' as const,
                isReadable: false,
                catalogValid: false,
                lastSyncedAt: null,
                contract: null
              }
            })
        })
      )

      expect(store.products).toEqual([])
      expect(store.customers).toEqual([])
      expect(store.total).toBe(0)
    })

    it('drops a refresh reply that was superseded by an owner change while in flight', async () => {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const store = useCatalogStore()
      const pending = store.refresh(
        refreshService({
          refresh: async () => {
            await gate
            return refreshResult({ revisionChanged: true })
          }
        })
      )

      // Logout / cashier switch / device recovery happens while the refresh is still running.
      store.resetCatalog()
      release?.()

      await expect(pending).resolves.toBeNull()
      // The late reply must never repopulate state for whoever the owner is now.
      expect(store.status).toBeNull()
      expect(store.lastRefreshedAt).toBeNull()
      expect(store.lastRefreshRevisionChanged).toBe(false)
    })
  })
})

describe('useCatalogStore — POS reliability rev 3 consistency', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const readable = {
    status: 'fresh',
    isReadable: true,
    catalogValid: true,
    lastSyncedAt: '2026-01-01T00:00:00Z',
    contract
  } as const

  it('drops a delayed initialize that was overtaken by a newer snapshot', async () => {
    const statuses: Array<(value: unknown) => void> = []
    const service = {
      getStatus: () => new Promise((resolve) => statuses.push(resolve)),
      listCategories: async () => [],
      listPaymentMethods: async () => [],
      searchProducts: async () => ({ items: [], total: 0, limit: 24, offset: 0, contract }),
      searchCustomers: async () => ({ items: [], total: 0, limit: 24, offset: 0 })
    } as unknown as CatalogRendererService
    const store = useCatalogStore()
    const slow = store.initialize(service)
    const fast = store.initialize(service)
    statuses[1](readable)
    await fast
    statuses[0]({ ...readable, contract: { ...contract, revision: 'e'.repeat(64) } })
    await slow
    expect(store.status?.contract?.revision).toBe(contract.revision)
  })

  it('never shows rows read under a different install than its status; re-reads status instead', async () => {
    const getStatus = vi.fn(async () => readable)
    const service = {
      getStatus,
      listCategories: async () => [],
      listPaymentMethods: async () => [],
      searchProducts: async () => ({
        items: [{ uuid: 'x' }],
        total: 1,
        limit: 24,
        offset: 0,
        contract: { ...contract, revision: 'f'.repeat(64) }
      }),
      searchCustomers: async () => ({ items: [], total: 0, limit: 24, offset: 0 })
    } as unknown as CatalogRendererService
    const store = useCatalogStore()
    store.status = readable as never
    await store.search(service)
    expect(store.products).toEqual([])
    expect(getStatus).toHaveBeenCalled()
  })

  it('keeps the stock facts that came with the page and clears them on owner reset', async () => {
    const service = {
      searchProducts: async () => ({
        items: [],
        total: 0,
        limit: 24,
        offset: 0,
        contract,
        stock: { p: { kind: 'untracked' } }
      })
    } as unknown as CatalogRendererService
    const store = useCatalogStore()
    await store.search(service)
    expect(store.stock).toEqual({ p: { kind: 'untracked' } })
    store.resetCatalog()
    expect(store.stock).toEqual({})
  })

  it('shares one change subscription between holders and releases it with the last one', () => {
    const unsubscribe = vi.fn()
    let listener:
      ((change: { reason: 'stock' | 'snapshot'; revision: string | null }) => void) | null = null
    const service = {
      onChanged: vi.fn((next) => {
        listener = next
        return unsubscribe
      }),
      getStatus: vi.fn(async () => readable),
      listCategories: async () => [],
      listPaymentMethods: async () => [],
      searchProducts: async () => ({ items: [], total: 0, limit: 24, offset: 0, contract }),
      searchCustomers: async () => ({ items: [], total: 0, limit: 24, offset: 0 })
    } as unknown as CatalogRendererService
    const store = useCatalogStore()
    const releaseA = store.subscribeToChanges(service)
    const releaseB = store.subscribeToChanges(service)
    expect(service.onChanged).toHaveBeenCalledTimes(1)
    const generation = store.generation
    listener!({ reason: 'snapshot', revision: null })
    expect(store.generation).toBe(generation + 1)
    releaseA()
    releaseA()
    expect(unsubscribe).not.toHaveBeenCalled()
    releaseB()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
