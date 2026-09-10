import { describe, expect, it } from 'vitest'
import { OfflineSaleReadinessService } from './offlineSaleReadiness.service'
import type { OfflineSaleReadinessOwner } from './offlineSaleReadiness.service'
import type { OfflineSaleAuthorityRow } from '@shared/contracts/sale.contract'

const OWNER: OfflineSaleReadinessOwner = {
  companyUuid: 'company-uuid',
  deviceUuid: 'device-uuid',
  warehouseUuid: 'warehouse-uuid'
}

const NOW = new Date('2026-09-11T12:00:00.000Z')

function authority(overrides: Partial<OfflineSaleAuthorityRow> = {}): OfflineSaleAuthorityRow {
  return {
    authorityUuid: 'authority-uuid',
    companyUuid: OWNER.companyUuid,
    deviceUuid: OWNER.deviceUuid,
    mode: 'physical_presence',
    policyRevision: 1,
    contractVersion: 3,
    issuedAt: '2026-09-11T00:00:00.000Z',
    notBefore: '2026-09-11T00:00:00.000Z',
    // 12 hours after NOW.
    notAfter: '2026-09-12T00:00:00.000Z',
    authorityHash: 'a'.repeat(64),
    observedAt: '2026-09-11T00:00:00.000Z',
    createdAt: '2026-09-11T00:00:00.000Z',
    ...overrides
  }
}

/** A database stub returning fixed rows for the three queries the service issues. */
function database(options: {
  pending?: number
  lastSync?: string | null
  stock?: Array<{ product_uuid: string; product_name: string; quantity: string }>
}): never {
  return {
    prepare(sql: string) {
      if (sql.includes('COUNT(*)')) {
        return { get: () => ({ n: options.pending ?? 0 }), all: () => [] }
      }

      if (sql.includes('MAX(synced_at)')) {
        return { get: () => ({ at: options.lastSync ?? null }), all: () => [] }
      }

      return { get: () => undefined, all: () => options.stock ?? [] }
    }
  } as never
}

function service(options: {
  authority?: OfflineSaleAuthorityRow | null
  now?: Date | null
  owner?: OfflineSaleReadinessOwner | null
  boundaries?: Record<string, unknown>
  pending?: number
  lastSync?: string | null
  stock?: Array<{ product_uuid: string; product_name: string; quantity: string }>
}): OfflineSaleReadinessService {
  return new OfflineSaleReadinessService({
    database: database(options),
    offlineSaleAuthorities: { findUsable: () => options.authority ?? null },
    trustedClock: {
      now: () =>
        options.now === null ? null : { now: options.now ?? NOW, rollbackDetected: false }
    },
    resolveOwner: () => (options.owner === undefined ? OWNER : options.owner),
    resolveBoundaries:
      options.boundaries === undefined ? undefined : () => options.boundaries as never
  })
}

describe('PS6 offline sale readiness', () => {
  it('reports legacy mode when the device holds no authority', () => {
    // The ordinary state, and never an error: this device sells under the legacy allocation rules.
    const readiness = service({ authority: null }).read()

    expect(readiness.mode).toBe('allocation_exclusive')
    expect(readiness.canSellWithoutQuota).toBe(false)
    expect(readiness.authorityUuid).toBeNull()
    // Null, not 0: there is no window, which is a different statement from "the window ended".
    expect(readiness.remainingSeconds).toBeNull()
    expect(readiness.limitingReason).toBe('none')
  })

  it('reports the window and names the authority ceiling as its limit', () => {
    const readiness = service({ authority: authority() }).read()

    expect(readiness.mode).toBe('physical_presence')
    expect(readiness.canSellWithoutQuota).toBe(true)
    expect(readiness.remainingSeconds).toBe(12 * 3600)
    expect(readiness.limitingReason).toBe('authority_ceiling')
    expect(readiness.notAfter).toBe('2026-09-12T00:00:00.000Z')
  })

  it('clips the countdown to an earlier observed boundary and names it', () => {
    // §14.3: the operator must be told WHICH boundary is limiting them, or "2 hours left" is
    // indistinguishable from the 72-hour ceiling when it is really the catalog contract expiring.
    const readiness = service({
      authority: authority(),
      boundaries: { catalogValidUntil: '2026-09-11T14:00:00.000Z' }
    }).read()

    expect(readiness.remainingSeconds).toBe(2 * 3600)
    expect(readiness.limitingReason).toBe('catalog_contract')
    expect(readiness.notAfter).toBe('2026-09-11T14:00:00.000Z')
  })

  it('never lets a boundary extend the window', () => {
    // A later, missing or unparseable boundary is skipped. The deadline can only ever move earlier.
    for (const boundaries of [
      { catalogValidUntil: '2099-01-01T00:00:00.000Z' },
      { catalogValidUntil: null },
      { catalogValidUntil: 'not-a-date' },
      { subscriptionExpiresAt: '2099-01-01T00:00:00.000Z' }
    ]) {
      const readiness = service({ authority: authority(), boundaries }).read()

      expect(readiness.remainingSeconds).toBe(12 * 3600)
      expect(readiness.limitingReason).toBe('authority_ceiling')
    }
  })

  it('refuses to show a countdown when trusted time is unavailable', () => {
    // Falling back to the wall clock would let a rolled-back clock display a window that does not
    // exist — the precise failure §14.3 names.
    const readiness = service({ authority: authority(), now: null }).read()

    expect(readiness.clockUntrusted).toBe(true)
    expect(readiness.remainingSeconds).toBeNull()
    expect(readiness.canSellWithoutQuota).toBe(false)
  })

  it('does not reset the window when read repeatedly', () => {
    // §14.3: the window never resets on launch, navigation, a refresh-only cycle, or a retry.
    const readinessService = service({ authority: authority() })

    const first = readinessService.read()
    const second = readinessService.read()
    const third = readinessService.read()

    expect(second.remainingSeconds).toBe(first.remainingSeconds)
    expect(third.notAfter).toBe(first.notAfter)
  })

  it('reports a categorical block separately and never as a countdown', () => {
    const readiness = service({
      authority: authority(),
      boundaries: { categoricalBlocks: ['device-blocked'] }
    }).read()

    expect(readiness.categoricalBlocks).toEqual(['device-blocked'])
    // Time still remains — the block is what stops the sale, and the two facts stay distinct.
    expect(readiness.remainingSeconds).toBe(12 * 3600)
    expect(readiness.canSellWithoutQuota).toBe(false)
  })

  it('reports pending uploads and the last successful sync', () => {
    const readiness = service({
      authority: authority(),
      pending: 3,
      lastSync: '2026-09-11T10:00:00.000Z'
    }).read()

    expect(readiness.pendingUploadCount).toBe(3)
    expect(readiness.lastSuccessfulSyncAt).toBe('2026-09-11T10:00:00.000Z')
  })

  it('surfaces negative cached balances as a non-blocking warning', () => {
    // The warning must NOT gate selling: `canSellWithoutQuota` stays true alongside it.
    const readiness = service({
      authority: authority(),
      stock: [
        { product_uuid: 'p1', product_name: 'Water 500ml', quantity: '-2.000' },
        { product_uuid: 'p2', product_name: 'Cola', quantity: '0.000' },
        { product_uuid: 'p3', product_name: 'Juice', quantity: '5.000' }
      ]
    }).read()

    expect(readiness.canSellWithoutQuota).toBe(true)
    expect(readiness.inventoryWarnings).toHaveLength(2)
    // Deepest deficit first.
    expect(readiness.inventoryWarnings[0].productUuid).toBe('p1')
    expect(readiness.inventoryWarnings[0].cachedQuantityMilli).toBe(-2000)
    expect(readiness.inventoryWarnings[1].cachedQuantityMilli).toBe(0)
  })

  it('parses a signed cached balance rather than throwing on it', () => {
    // The fingerprint helper's `quantityToMilli` rejects a leading '-', because a SALE quantity is
    // never negative. Reusing it here would throw on exactly the rows this warning exists to show.
    const readiness = service({
      authority: authority(),
      stock: [
        { product_uuid: 'p1', product_name: 'A', quantity: '-4.500' },
        { product_uuid: 'p2', product_name: 'B', quantity: '-0.500' },
        { product_uuid: 'p3', product_name: 'C', quantity: 'unparseable' }
      ]
    }).read()

    expect(readiness.inventoryWarnings.map((w) => w.cachedQuantityMilli)).toEqual([-4500, -500])
  })

  it('reports legacy mode with no owner and never throws', () => {
    const readiness = service({ owner: null }).read()

    expect(readiness.mode).toBe('allocation_exclusive')
    expect(readiness.pendingUploadCount).toBe(0)
    expect(readiness.inventoryWarnings).toEqual([])
  })
})
