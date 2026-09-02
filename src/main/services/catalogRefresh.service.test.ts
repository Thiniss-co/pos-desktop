import { describe, expect, it, vi } from 'vitest'
import type { BootstrapResult } from '@shared/contracts/bootstrap.contract'
import type { CatalogStatus } from '@shared/contracts/catalog.contract'
import type { CommercialAccessSnapshot, LicenseStatus } from '@shared/contracts/license.contract'
import { CatalogRefreshService } from './catalogRefresh.service'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)

function status(overrides: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    status: 'fresh',
    isReadable: true,
    catalogValid: true,
    lastSyncedAt: '2026-01-01T00:00:00+00:00',
    contract: {
      revision: REVISION_A,
      generatedAt: '2026-01-01T00:00:00+00:00',
      validUntil: '2026-01-05T00:00:00+00:00',
      currency: 'EGP',
      currencyExponent: 2,
      quantityScale: 3,
      minimumQuantity: '0.001',
      maximumQuantity: '999999.999',
      maximumUnitPrice: 1_000_000_000,
      maximumLineTotal: 900_000_000_000_000,
      maximumInvoiceTotal: 900_000_000_000_000,
      mixedTaxModePolicy: 'single_invoice_mode'
    },
    ...overrides
  } as CatalogStatus
}

function bootstrapResult(revision = REVISION_A): BootstrapResult {
  return {
    isComplete: true,
    snapshotVersion: '20260101000000',
    serverTime: '2026-01-01T00:00:00+00:00',
    fetchedAt: '2026-01-01T02:00:00.000Z',
    counts: { products: 3, payment_methods: 1, customers: 2, stock_items: 3 },
    catalog: {
      revision,
      generatedAt: '2026-01-01T00:00:00+00:00',
      validUntil: '2026-01-05T00:00:00+00:00'
    }
  }
}

function licenseStatus(validatedAt: string | null = '2026-01-01T02:00:00+00:00'): LicenseStatus {
  return {
    restrictionLevel: 'none',
    canSell: true,
    canSync: true,
    isActive: true,
    isInGrace: false,
    isExpired: false,
    expiresAt: null,
    warningMessage: null,
    validatedAt,
    serverTime: '2026-01-01T02:00:00+00:00',
    nextValidationDueAt: '2026-01-08T02:00:00+00:00',
    maxOfflineHours: 72,
    subscription: null
  } as unknown as LicenseStatus
}

function accessSnapshot(allowed = true): CommercialAccessSnapshot {
  const decision = {
    allowed,
    reason: allowed ? null : ('validation-overdue' as const),
    warning: null,
    retryable: false,
    evaluatedAt: '2026-01-01T02:00:00+00:00',
    nextValidationDueAt: null,
    restrictionLevel: null,
    warningMessage: null
  }

  return {
    sell: { ...decision, action: 'sell' },
    sync: { ...decision, action: 'sync' }
  } as unknown as CommercialAccessSnapshot
}

interface HarnessOptions {
  readonly before?: CatalogStatus
  readonly after?: CatalogStatus
  readonly result?: BootstrapResult
  readonly ensure?: () => Promise<void>
  readonly refresh?: () => Promise<BootstrapResult>
  readonly validate?: () => Promise<LicenseStatus>
  readonly access?: CommercialAccessSnapshot
}

interface Harness {
  readonly service: CatalogRefreshService
  readonly order: string[]
  readonly ensureCatalogReadContext: ReturnType<typeof vi.fn>
  readonly validate: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly reconcileShift: ReturnType<typeof vi.fn>
  readonly begin: ReturnType<typeof vi.fn>
  readonly publish: ReturnType<typeof vi.fn>
  readonly getStatus: ReturnType<typeof vi.fn>
}

function harness(options: HarnessOptions = {}): Harness {
  const order: string[] = []
  const statuses = [options.before ?? status(), options.after ?? status()]
  let statusReads = 0

  const validate = vi.fn(async () => {
    order.push('validate')
    return options.validate ? await options.validate() : licenseStatus()
  })
  const describe = vi.fn(() => {
    order.push('describe')
    return options.access ?? accessSnapshot()
  })
  const ensureCatalogReadContext = vi.fn(async () => {
    order.push('authorize')
    await options.ensure?.()
  })
  const refresh = vi.fn(async () => {
    order.push('refresh')
    return options.refresh ? await options.refresh() : (options.result ?? bootstrapResult())
  })
  const reconcileShift = vi.fn(async () => {
    order.push('shift-reconcile')
  })
  const begin = vi.fn(() => {
    order.push('begin')
    return 7
  })
  const publish = vi.fn(() => {
    order.push('publish')
  })
  const getStatus = vi.fn(() => {
    order.push('status')
    const value = statuses[Math.min(statusReads, statuses.length - 1)]
    statusReads += 1
    return value
  })

  const service = new CatalogRefreshService({
    license: { validate },
    authorizer: { ensureCatalogReadContext },
    source: { refresh },
    shiftReconciler: { current: reconcileShift },
    catalog: { getStatus },
    access: { describe },
    accessPublisher: { begin, publish }
  })

  return {
    service,
    order,
    ensureCatalogReadContext,
    validate,
    refresh,
    reconcileShift,
    begin,
    publish,
    getStatus
  }
}

describe('CatalogRefreshService', () => {
  it('validates the license before anything that depends on canSync', async () => {
    const { service, order } = harness()

    await service.refresh()

    // An overdue license denies `canSync`, and `BootstrapService.refresh()` asserts it — so
    // validation must precede both the session step and the bootstrap, or the chain can never
    // recover a workstation that is blocked precisely because its license lapsed.
    expect(order.indexOf('validate')).toBeLessThan(order.indexOf('authorize'))
    expect(order.indexOf('validate')).toBeLessThan(order.indexOf('refresh'))
  })

  it('publishes the refreshed access decision as soon as the license is valid again', async () => {
    const { service, order } = harness()

    await service.refresh()

    // Published between validation and the bootstrap leg, so an overdue warning clears immediately
    // rather than lingering until the whole chain finishes.
    const firstPublish = order.indexOf('publish')
    expect(order.indexOf('validate')).toBeLessThan(firstPublish)
    expect(firstPublish).toBeLessThan(order.indexOf('refresh'))
  })

  it('authorizes the session before the bootstrap request', async () => {
    const { service, order } = harness()

    await service.refresh()

    expect(order.indexOf('authorize')).toBeLessThan(order.indexOf('refresh'))
  })

  it('reconciles the main-owned current shift after bootstrap and before reporting success', async () => {
    const { service, order, reconcileShift } = harness()

    await service.refresh()

    expect(reconcileShift).toHaveBeenCalledTimes(1)
    expect(order.indexOf('refresh')).toBeLessThan(order.indexOf('shift-reconcile'))
    expect(order.indexOf('shift-reconcile')).toBeLessThan(order.lastIndexOf('status'))
  })

  it('retains fail-closed state and surfaces the real error when validation fails', async () => {
    const transportFailure = {
      category: 'transport',
      message: 'The desktop service could not be reached.',
      retryable: true
    }
    const { service, ensureCatalogReadContext, refresh, publish } = harness({
      validate: () => Promise.reject(transportFailure)
    })

    // The actual transport/business error reaches the caller unchanged — never a generic message
    // and never a silently softened restriction.
    await expect(service.refresh()).rejects.toEqual(transportFailure)
    // Nothing downstream ran, and no access snapshot was published, so the denied state stands.
    expect(ensureCatalogReadContext).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('returns the main-owned access decision and server-derived validation timestamp', async () => {
    const { service } = harness()

    const result = await service.refresh()

    expect(result.access.sell.allowed).toBe(true)
    expect(result.access.sync.allowed).toBe(true)
    // Server-derived, persisted by LicenseService, reported for display only.
    expect(result.licenseValidatedAt).toBe('2026-01-01T02:00:00+00:00')
  })

  it('reports a still-denied access decision rather than claiming success', async () => {
    const { service } = harness({ access: accessSnapshot(false) })

    const result = await service.refresh()

    // Validation succeeded as a request but the workstation is still denied (e.g. an expired
    // subscription). The renderer must be told the truth, not shown a cleared warning.
    expect(result.access.sell.allowed).toBe(false)
    expect(result.access.sell.reason).toBe('validation-overdue')
  })

  it('never reaches the bootstrap when the session context cannot be established', async () => {
    const authorizationFailure = {
      category: 'authorization',
      message: 'Sign in again before refreshing workstation data.',
      retryable: false
    }
    const { service, refresh, begin, publish } = harness({
      ensure: () => Promise.reject(authorizationFailure)
    })

    await expect(service.refresh()).rejects.toEqual(authorizationFailure)
    expect(refresh).not.toHaveBeenCalled()
    // The license leg ran and published before the session check; the bootstrap leg did not.
    expect(begin).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes a second access revision after the bootstrap leg', async () => {
    const { service, order, publish } = harness()

    await service.refresh()

    // Two cycles: one for the license, one for whatever the bootstrap itself revealed.
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(7)
    expect(order.lastIndexOf('refresh')).toBeLessThan(order.lastIndexOf('publish'))
  })

  it('does not publish a post-bootstrap snapshot when the bootstrap fails', async () => {
    const failure = { category: 'transport', message: 'unreachable', retryable: true }
    const { service, publish } = harness({ refresh: () => Promise.reject(failure) })

    await expect(service.refresh()).rejects.toEqual(failure)
    // The license leg already published legitimately; the bootstrap leg must not.
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('recalculates catalog status after the snapshot is persisted, not before', async () => {
    const { service, getStatus } = harness({
      before: status({ status: 'stale', catalogValid: false }),
      after: status({ status: 'fresh', catalogValid: true })
    })

    const result = await service.refresh()

    // Read twice: once for the pre-refresh revision, once for the recalculated status returned.
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(result.status.status).toBe('fresh')
    expect(result.status.catalogValid).toBe(true)
  })

  it('reports a changed revision without acting on the cart itself', async () => {
    const { service } = harness({ result: bootstrapResult(REVISION_B) })

    const result = await service.refresh()

    expect(result.previousRevision).toBe(REVISION_A)
    expect(result.revisionChanged).toBe(true)
  })

  it('reports an unchanged revision when the catalog did not move', async () => {
    const { service } = harness({ result: bootstrapResult(REVISION_A) })

    const result = await service.refresh()

    expect(result.revisionChanged).toBe(false)
  })

  it('treats a first-ever refresh as unchanged rather than a revision change', async () => {
    const { service } = harness({
      before: status({ status: 'unavailable', isReadable: false, contract: null }),
      result: bootstrapResult(REVISION_B)
    })

    const result = await service.refresh()

    expect(result.previousRevision).toBeNull()
    // There was no prior revision to move away from, so nothing can need a cart rebuild.
    expect(result.revisionChanged).toBe(false)
  })

  it('returns the refresh timestamp and the persisted counts', async () => {
    const { service } = harness()

    const result = await service.refresh()

    expect(result.refreshedAt).toBe('2026-01-01T02:00:00.000Z')
    expect(result.counts).toEqual({
      products: 3,
      payment_methods: 1,
      customers: 2,
      stock_items: 3
    })
  })

  it('coalesces concurrent refreshes into one publication cycle', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, refresh, begin, publish } = harness({
      refresh: async () => {
        await gate
        return bootstrapResult()
      }
    })

    const first = service.refresh()
    const second = service.refresh()
    release?.()
    const [a, b] = await Promise.all([first, second])

    expect(refresh).toHaveBeenCalledTimes(1)
    // One coalesced chain: two publication cycles total, not four.
    expect(begin).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(2)
    // Both callers observe the identical result — never two conflicting snapshots.
    expect(a).toEqual(b)
  })

  it('allows a new refresh once the previous one settled', async () => {
    const { service, refresh } = harness()

    await service.refresh()
    await service.refresh()

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('allows a retry after a failed refresh rather than latching the in-flight guard', async () => {
    let attempt = 0
    const { service } = harness({
      refresh: async () => {
        attempt += 1
        if (attempt === 1) {
          throw { category: 'transport', message: 'unreachable', retryable: true }
        }
        return bootstrapResult()
      }
    })

    await expect(service.refresh()).rejects.toMatchObject({ category: 'transport' })
    await expect(service.refresh()).resolves.toMatchObject({ revisionChanged: false })
    expect(attempt).toBe(2)
  })
})
