import { beforeEach, describe, expect, it } from 'vitest'
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
