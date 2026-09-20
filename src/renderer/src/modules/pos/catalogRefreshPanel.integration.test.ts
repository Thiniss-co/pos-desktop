// @vitest-environment happy-dom

/**
 * Proves that clicking the actual rendered `CatalogRefreshPanel` button reaches the real,
 * production `useCatalogStore().refresh()` action — not a mock of the store — and that a
 * successful refresh reloads the store's catalog data. `catalog.store.test.ts` already proves
 * `refresh()` itself in isolation (including its in-flight dedup guard); what is missing there,
 * and what this file adds, is the wiring: does the panel's `@refresh` emission actually reach that
 * action the way `PosPage.vue`'s `handleRefreshCatalog()` wires it (`void catalog.refresh()`)?
 *
 * The store is real (`createPinia()` + `useCatalogStore()`); only the IPC-backed
 * `CatalogRendererService` is swapped for a fake, exactly as `catalog.store.test.ts` already does —
 * this is the sanctioned seam (`refresh(service = new CatalogRendererService())`), not a second
 * bootstrap path or new IPC surface.
 *
 * This file lives beside `catalog.store.test.ts` rather than next to the component itself:
 * `shared/components/pos/importBoundary.test.ts` sweeps every file in that directory (including
 * test files) and forbids importing a business Pinia store, to keep that directory auditably pure
 * presentation. This test intentionally crosses that boundary to prove the wiring, so it belongs
 * on the module side of it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type { CatalogContract, CatalogProductPage } from '@shared/contracts/catalog.contract'
import CatalogRefreshPanel from '@renderer/shared/components/pos/CatalogRefreshPanel.vue'
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

function fakeService(overrides: Record<string, unknown> = {}): CatalogRendererService {
  return {
    refresh: async () => refreshResult(),
    listCategories: async () => [{ uuid: 'cat-1', name: 'Drinks' }],
    listPaymentMethods: async () => [{ uuid: 'pm-1', name: 'Cash', code: 'cash', type: 'cash' }],
    searchProducts: async () => page(4),
    searchCustomers: async () => ({ items: [], total: 0, limit: 24, offset: 0 }),
    ...overrides
  } as unknown as CatalogRendererService
}

let wrappers: VueWrapper[] = []

afterEach(() => {
  for (const wrapper of wrappers) {
    wrapper.unmount()
  }
  wrappers = []
})

describe('CatalogRefreshPanel wired to the production catalog store', () => {
  it('reaches the real refresh action and reloads catalog data after success', async () => {
    setActivePinia(createPinia())
    const catalog = useCatalogStore()
    const service = fakeService()

    // Nothing refreshed yet: exactly the "fresh catalog, no previous refresh" shape.
    expect(catalog.total).toBe(0)
    expect(catalog.lastRefreshedAt).toBeNull()

    const wrapper = mount(CatalogRefreshPanel, {
      props: {
        pending: catalog.isRefreshing,
        stale: false,
        staleMessage: 'stale',
        refreshLabel: 'Refresh workstation data',
        pendingLabel: 'Refreshing workstation data…',
        lastRefreshedLabel: catalog.lastRefreshedAt,
        errorMessage: catalog.refreshError,
        revisionChangedMessage: null,
        // Vue 3's `onRefresh` prop is exactly what `@refresh="..."` compiles to — the same
        // listener PosPage.vue attaches to this component, not a test-only shortcut.
        onRefresh: () => {
          void catalog.refresh(service)
        }
      },
      attachTo: document.body
    })
    wrappers.push(wrapper)

    await wrapper.find('[data-testid="catalog-refresh-action"]').trigger('click')
    await flushPromises()

    // The production action ran against the real store, through the fake service boundary only —
    // and reloaded every cached view from that one refresh.
    expect(catalog.total).toBe(4)
    expect(catalog.categories).toHaveLength(1)
    expect(catalog.paymentMethods).toHaveLength(1)
    expect(catalog.lastRefreshedAt).toBe('2026-01-01T02:00:00.000Z')
    expect(catalog.refreshError).toBeNull()
    expect(catalog.isRefreshing).toBe(false)
  })

  it('cannot start a concurrent refresh from rapid repeated clicks on the real refresh path', async () => {
    setActivePinia(createPinia())
    const catalog = useCatalogStore()

    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = fakeService({
      refresh: async () => {
        calls += 1
        await gate
        return refreshResult()
      }
    })

    const wrapper = mount(CatalogRefreshPanel, {
      props: {
        pending: false,
        stale: false,
        staleMessage: 'stale',
        refreshLabel: 'Refresh workstation data',
        pendingLabel: 'Refreshing workstation data…',
        lastRefreshedLabel: null,
        errorMessage: null,
        revisionChangedMessage: null,
        onRefresh: () => {
          void catalog.refresh(service)
        }
      },
      attachTo: document.body
    })
    wrappers.push(wrapper)

    const action = (): DOMWrapper<Element> => wrapper.find('[data-testid="catalog-refresh-action"]')

    // Two clicks dispatched before either awaits: both DOM events fire, and both reach the
    // `onRefresh` handler, before Vue has re-rendered the button as disabled. The real production
    // guard is `useCatalogStore().refresh()`'s own `isRefreshing` check — set synchronously on the
    // FIRST call, before its first `await` — which is what must stop the second one, not a race
    // against how quickly the DOM updates.
    await Promise.all([action().trigger('click'), action().trigger('click')])

    expect(calls).toBe(1)
    expect(catalog.isRefreshing).toBe(true)

    release?.()
    await flushPromises()

    expect(catalog.isRefreshing).toBe(false)
    expect(calls).toBe(1)
  })
})
