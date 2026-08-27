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
})
