import { describe, expect, it, vi } from 'vitest'
import type { ConnectivityStatus } from '@shared/contracts/connectivity.contract'
import type { SqliteDatabase } from '../database/connection'
import { AllocationAcquisitionService } from './allocationAcquisition.service'

const owner = {
  companyUuid: '11111111-1111-4111-8111-111111111111',
  deviceUuid: '33333333-3333-4333-8333-333333333333',
  warehouseUuid: '88888888-8888-4888-8888-888888888888'
}
const productUuid = '66666666-6666-4666-8666-666666666666'
const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = '2026-01-01T02:00:00.000Z'
const trackedLines = [{ lineId: 'line-1', productUuid, requiredMilli: 1000 }]

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    contract_version: 1,
    company_uuid: owner.companyUuid,
    device_uuid: owner.deviceUuid,
    warehouse_uuid: owner.warehouseUuid,
    product_uuid: productUuid,
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 1000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 1000,
    consume_until: '2026-01-03T00:00:00+00:00',
    status: 'active',
    envelope_hash: 'd'.repeat(64),
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null,
    ...overrides
  }
}

function build(options: {
  usableMilli?: number
  capability?: 'supported' | 'unavailable' | null
  status?: ConnectivityStatus
  requestWithMeta?: ReturnType<typeof vi.fn>
  ingestTopUpGrants?: ReturnType<typeof vi.fn>
  assertRequestPreconditions?: ReturnType<typeof vi.fn>
}): {
  readonly service: AllocationAcquisitionService
  readonly requestWithMeta: ReturnType<typeof vi.fn>
  readonly ingestTopUpGrants: ReturnType<typeof vi.fn>
  readonly log: ReturnType<typeof vi.fn>
} {
  const requestWithMeta =
    options.requestWithMeta ??
    vi.fn().mockResolvedValue({ data: [envelope()], meta: { allocation_revision: 11 } })
  const ingestTopUpGrants = options.ingestTopUpGrants ?? vi.fn()
  const capability = options.capability === undefined ? 'supported' : options.capability
  const log = vi.fn()

  const service = new AllocationAcquisitionService({
    // `transaction()` is invoked, not simulated away: the acquisition must never persist outside one.
    database: { transaction: (fn: () => void) => () => fn() } as unknown as SqliteDatabase,
    apiClient: {
      assertRequestPreconditions: options.assertRequestPreconditions ?? vi.fn(),
      requestWithMeta
    },
    stockAllocations: {
      getCapability: () =>
        capability === null ? null : { state: capability, revision: 10, observedAt: NOW },
      ingestTopUpGrants,
      usableGrantsForProduct: () => [],
      remainingMilli: () => 0
    },
    allocationService: { usableRemainingMilli: () => options.usableMilli ?? 0 },
    connectivity: {
      getSnapshot: () => ({
        status: options.status ?? 'online',
        networkAvailable: true,
        backendReachable: true,
        checkedAt: NOW,
        lastBackendReachableAt: NOW,
        reason: 'probe_succeeded'
      })
    },
    log
  } as unknown as ConstructorParameters<typeof AllocationAcquisitionService>[0])

  return { service, requestWithMeta, ingestTopUpGrants, log }
}

function acquire(
  service: AllocationAcquisitionService
): ReturnType<AllocationAcquisitionService['acquire']> {
  return service.acquire({ attemptKey: ATTEMPT_KEY, owner, trackedLines, nowIso: NOW })
}

describe('AllocationAcquisitionService', () => {
  it('performs no request when local coverage is already sufficient', async () => {
    const { service, requestWithMeta, ingestTopUpGrants, log } = build({ usableMilli: 1000 })

    expect(await acquire(service)).toEqual({ kind: 'proceed' })
    expect(requestWithMeta).not.toHaveBeenCalled()
    expect(ingestTopUpGrants).not.toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toContain('event=top-up-not-required')
  })

  it('performs no request while the backend is not proven reachable', async () => {
    for (const status of ['offline', 'backend_unreachable', 'checking'] as const) {
      const { service, requestWithMeta } = build({ status })

      expect(await acquire(service)).toEqual({ kind: 'proceed' })
      expect(requestWithMeta).not.toHaveBeenCalled()
    }
  })

  it('performs no request when the backend predates the allocation contract', async () => {
    const { service, requestWithMeta } = build({ capability: 'unavailable' })

    expect(await acquire(service)).toEqual({ kind: 'proceed' })
    expect(requestWithMeta).not.toHaveBeenCalled()
  })

  it('performs no request when the authenticated request preconditions do not hold', async () => {
    const { service, requestWithMeta } = build({
      assertRequestPreconditions: vi.fn().mockImplementation(() => {
        throw new Error('no token')
      })
    })

    expect(await acquire(service)).toEqual({ kind: 'proceed' })
    expect(requestWithMeta).not.toHaveBeenCalled()
  })

  it('sends the exact deficit to the desktop top-up route and persists the grant', async () => {
    const { service, requestWithMeta, ingestTopUpGrants } = build({ usableMilli: 250 })

    expect(await acquire(service)).toEqual({ kind: 'proceed' })
    expect(requestWithMeta).toHaveBeenCalledTimes(1)
    const [route, body] = requestWithMeta.mock.calls[0]
    expect(route).toMatchObject({ path: '/stock-allocations/top-up', method: 'POST' })
    expect(body.items).toEqual([{ product_uuid: productUuid, quantity: '0.750' }])
    expect(ingestTopUpGrants).toHaveBeenCalledTimes(1)
    expect(ingestTopUpGrants.mock.calls[0][0]).toHaveLength(1)
  })

  const definitiveRejections = [
    ['authorization', {}, 'permission-denied'],
    ['authentication', {}, 'policy-blocked'],
    ['validation', { fieldErrors: { device: ['assign a warehouse'] } }, 'workstation-unassigned'],
    ['validation', { fieldErrors: { items: ['unknown product'] } }, 'refresh-required'],
    ['rejected', {}, 'context-changed'],
    ['configuration', {}, 'context-changed']
  ] as const

  for (const [category, extra, expected] of definitiveRejections) {
    it(`maps a definitive ${category} rejection to ${expected} and persists nothing`, async () => {
      const { service, ingestTopUpGrants } = build({
        requestWithMeta: vi.fn().mockRejectedValue({
          category,
          message: 'denied',
          retryable: false,
          ...extra
        })
      })

      expect(await acquire(service)).toEqual({ kind: 'blocked', code: expected })
      expect(ingestTopUpGrants).not.toHaveBeenCalled()
    })
  }

  const ambiguousOutcomes = [
    [
      'a transport failure',
      vi.fn().mockRejectedValue({ category: 'transport', message: 'x', retryable: true })
    ],
    [
      'a conflict',
      vi.fn().mockRejectedValue({ category: 'conflict', message: 'x', retryable: false })
    ],
    ['an unexpected error', vi.fn().mockRejectedValue(new Error('socket hang up'))],
    ['a malformed body', vi.fn().mockResolvedValue({ data: { nope: true }, meta: {} })],
    [
      'a missing allocation revision',
      vi.fn().mockResolvedValue({ data: [envelope()], meta: { trace_id: 't' } })
    ],
    [
      'a stale allocation revision',
      vi.fn().mockResolvedValue({ data: [envelope()], meta: { allocation_revision: 9 } })
    ]
  ] as const

  for (const [label, requestWithMeta] of ambiguousOutcomes) {
    it(`treats ${label} as unresolved and never mints a new key`, async () => {
      const { service, ingestTopUpGrants } = build({ requestWithMeta })

      expect(await acquire(service)).toEqual({
        kind: 'blocked',
        code: 'allocation-acquisition-unresolved'
      })
      expect(ingestTopUpGrants).not.toHaveBeenCalled()
    })
  }

  const foreignEnvelopes = [
    ['device', { device_uuid: '99999999-9999-4999-8999-999999999911' }],
    ['warehouse', { warehouse_uuid: '99999999-9999-4999-8999-999999999922' }],
    ['company', { company_uuid: '99999999-9999-4999-8999-999999999933' }],
    ['product', { product_uuid: '99999999-9999-4999-8999-999999999944' }],
    ['contract version', { contract_version: 2 }],
    ['status', { status: 'quarantined' }],
    ['quantity arithmetic', { remaining_quantity_milli: 999 }],
    ['generation ordering', { rights_generation: 3 }]
  ] as const

  for (const [label, overrides] of foreignEnvelopes) {
    it(`refuses to persist a response with an invalid ${label}`, async () => {
      const { service, ingestTopUpGrants } = build({
        requestWithMeta: vi
          .fn()
          .mockResolvedValue({ data: [envelope(overrides)], meta: { allocation_revision: 11 } })
      })

      expect(await acquire(service)).toEqual({
        kind: 'blocked',
        code: 'allocation-acquisition-unresolved'
      })
      expect(ingestTopUpGrants).not.toHaveBeenCalled()
    })
  }

  it('refuses a response containing two grants with the same identity', async () => {
    const { service, ingestTopUpGrants } = build({
      requestWithMeta: vi.fn().mockResolvedValue({
        data: [envelope(), envelope()],
        meta: { allocation_revision: 11 }
      }),
      ingestTopUpGrants: vi.fn().mockImplementation(() => {
        throw new Error('The allocation top-up response contains a duplicate allocation UUID')
      })
    })

    expect(await acquire(service)).toEqual({
      kind: 'blocked',
      code: 'allocation-acquisition-unresolved'
    })
    expect(ingestTopUpGrants).toHaveBeenCalledTimes(1)
  })

  it('preserves an unexpected server lifecycle status verbatim instead of normalizing it', async () => {
    const { service, ingestTopUpGrants } = build({
      requestWithMeta: vi.fn().mockResolvedValue({
        data: [envelope({ status: 'revocation_pending' })],
        meta: { allocation_revision: 11 }
      })
    })

    await acquire(service)

    expect(ingestTopUpGrants.mock.calls[0][0][0]).toMatchObject({ status: 'revocation_pending' })
  })

  it('emits only sanitized categorical diagnostics', async () => {
    const { service, log } = build({})

    await acquire(service)

    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.includes('event=top-up-requested'))).toBe(true)
    expect(lines.some((line) => line.includes('event=grant-persistence-committed'))).toBe(true)
    for (const line of lines) {
      expect(line).not.toContain(productUuid)
      expect(line).not.toContain(owner.deviceUuid)
      expect(line).not.toContain(ATTEMPT_KEY)
      expect(line).not.toContain('d'.repeat(64))
    }
  })
})
