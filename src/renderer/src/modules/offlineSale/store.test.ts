import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { useOfflineSaleStore } from './store'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'

function readiness(overrides: Partial<OfflineSaleReadiness> = {}): OfflineSaleReadiness {
  return {
    mode: 'physical_presence',
    canSellWithoutQuota: true,
    authorityUuid: 'authority-uuid',
    notAfter: '2026-09-12T00:00:00.000Z',
    remainingSeconds: 43_200,
    limitingReason: 'authority_ceiling',
    categoricalBlocks: [],
    pendingUploadCount: 0,
    lastSuccessfulSyncAt: null,
    inventoryWarnings: [],
    clockUntrusted: false,
    ...overrides
  }
}

function stubPosApi(result: unknown): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    posApi: { offlineSale: { getReadiness: vi.fn().mockResolvedValue(result) } }
  }
}

describe('PS6 offline sale store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('exposes readiness exactly as main reported it', async () => {
    stubPosApi({ ok: true, data: readiness() })
    const store = useOfflineSaleStore()

    await store.refresh()

    expect(store.canSellWithoutQuota).toBe(true)
    expect(store.isPhysicalPresence).toBe(true)
    // Re-read, never re-derived: the store holds main's number rather than computing one.
    expect(store.readiness?.remainingSeconds).toBe(43_200)
  })

  it('never infers permission from the absence of an error', async () => {
    stubPosApi({
      ok: true,
      data: readiness({ canSellWithoutQuota: false, mode: 'allocation_exclusive' })
    })
    const store = useOfflineSaleStore()

    await store.refresh()

    expect(store.canSellWithoutQuota).toBe(false)
    expect(store.error).toBeNull()
  })

  it('keeps the inventory warning independent of permission', async () => {
    // The warning is information about the ledger, never a gate. Tying the two would let a display
    // concern become a permission.
    stubPosApi({
      ok: true,
      data: readiness({
        inventoryWarnings: [
          {
            productUuid: 'p1',
            productName: 'Water',
            cachedQuantityMilli: -2000,
            atOrBelowZero: true
          }
        ]
      })
    })
    const store = useOfflineSaleStore()

    await store.refresh()

    expect(store.hasInventoryWarning).toBe(true)
    expect(store.canSellWithoutQuota).toBe(true)
  })

  it('surfaces a localized error and leaves readiness untouched on failure', async () => {
    stubPosApi({
      ok: false,
      error: { category: 'unexpected', message: 'boom', retryable: false }
    })
    const store = useOfflineSaleStore()

    await store.refresh()

    expect(store.error).not.toBeNull()
    expect(store.readiness).toBeNull()
  })
})

describe('PS6 IPC boundary', () => {
  it('exposes exactly one read-only offline-sale channel and no write channel', () => {
    // §14.3: a renderer may OBSERVE readiness; it never grants it. Asserted against the preload
    // surface itself, because that file is the actual boundary — a reviewer's memory is not.
    const preload = readFileSync('src/preload/posApi.ts', 'utf8')
    const offlineSaleBlock = preload.slice(
      preload.indexOf('offlineSale: Object.freeze({'),
      preload.indexOf('preparation: Object.freeze({')
    )

    expect(offlineSaleBlock).toContain('getReadiness')
    // No mutating verb reaches this surface at all.
    for (const forbidden of ['set', 'issue', 'grant', 'renew', 'extend', 'run', 'apply']) {
      expect(offlineSaleBlock.toLowerCase()).not.toContain(`${forbidden}(`)
    }

    // The channel takes an empty object: the renderer supplies no owner, clock, window or authority.
    expect(offlineSaleBlock).toContain('offlineSaleGetReadiness, {}')
  })

  it('never exposes a token or an authority hash to the renderer', () => {
    // The readiness resource carries only what an operator display needs.
    const contract = readFileSync('src/shared/contracts/offlineSaleReadiness.contract.ts', 'utf8')

    expect(contract).not.toContain('token')
    expect(contract).not.toContain('authorityHash')
    expect(contract).not.toContain('signed_payload')
  })
})
