import { describe, expect, it, vi } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import { BootstrapService } from './bootstrap.service'
import type { StoredDeviceIdentity } from './deviceIdentity.service'
import { desktopBootstrapFixture } from '../testing/fixtures/desktopBootstrap.fixture'

const identity: StoredDeviceIdentity = {
  deviceUuid: '00000000-0000-4000-8000-000000000003',
  deviceName: 'Front Register',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: true
}

const syncAllowed = { assertCanSync: () => undefined }

function loyaltySettings(pointsExpireAfterDays: unknown): Record<string, unknown> {
  return {
    enabled: true,
    earn_enabled: true,
    redeem_enabled: true,
    points_per_amount: 1,
    amount_per_point: 1,
    minimum_redeem_points: 1,
    maximum_redeem_percent: 100,
    points_expire_after_days: pointsExpireAfterDays,
    points_activate_after_days: 0,
    allow_partial_redemption: true
  }
}

function bootstrapSuccessEnvelope(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: true,
    message: 'Bootstrap retrieved.',
    code: 'DESKTOP_BOOTSTRAP_RETRIEVED',
    data: {
      ...desktopBootstrapFixture(),
      device: {
        id: '22222222-2222-4222-8222-222222222222',
        device_uuid: identity.deviceUuid,
        device_name: identity.deviceName,
        platform: identity.platform,
        status: 'active',
        last_seen_at: null,
        last_license_validated_at: null
      },
      ...overrides
    },
    meta: {}
  }
}

function createApiClient(payload: unknown, status = 200): DesktopApiClient {
  return new DesktopApiClient({
    apiOrigin: new URL('https://api.example.test'),
    getAccessToken: () => 'token',
    getDeviceUuid: () => identity.deviceUuid,
    fetchImplementation: (async () => ({
      ok: status < 400,
      status,
      json: async () => payload
    })) as unknown as typeof fetch
  })
}

describe('BootstrapService.refresh', () => {
  it('blocks with an authorization error when the device is not activated', async () => {
    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope()),
      { get: () => null },
      syncAllowed,
      { persistSnapshot: () => ({ snapshotVersion: 'x', serverTime: 'x', counts: {} }) }
    )

    await expect(service.refresh()).rejects.toMatchObject({ category: 'authorization' })
  })

  it('blocks with an authorization error when the cached license forbids sync', async () => {
    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope()),
      { get: () => identity },
      {
        assertCanSync: () => {
          throw {
            category: 'authorization',
            message: 'Subscription expired',
            retryable: false
          }
        }
      },
      { persistSnapshot: () => ({ snapshotVersion: 'x', serverTime: 'x', counts: {} }) }
    )

    await expect(service.refresh()).rejects.toMatchObject({
      category: 'authorization',
      message: 'Subscription expired'
    })
  })

  it('publishes only after the snapshot transaction succeeds, returning sanitized counts', async () => {
    let persistedCalledBefore = false
    let publishedAfterPersist = false

    const service = new BootstrapService(
      createApiClient(
        bootstrapSuccessEnvelope({
          categories: [
            { id: '22222222-2222-4222-8222-222222222222', name: 'Drinks', is_active: true }
          ]
        })
      ),
      { get: () => identity },
      syncAllowed,
      {
        persistSnapshot: () => {
          persistedCalledBefore = true
          return {
            snapshotVersion: '20260101000000',
            serverTime: '2026-01-01T00:00:00Z',
            counts: { categories: 1 }
          }
        }
      },
      () => {
        expect(persistedCalledBefore).toBe(true)
        publishedAfterPersist = true
      }
    )

    const result = await service.refresh()

    expect(publishedAfterPersist).toBe(true)
    expect(result).toEqual({
      isComplete: true,
      snapshotVersion: '20260101000000',
      serverTime: '2026-01-01T00:00:00Z',
      fetchedAt: expect.any(String),
      counts: { categories: 1 },
      catalog: {
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        generatedAt: '2026-01-01T00:00:00+00:00',
        validUntil: '2026-01-04T00:00:00+00:00'
      }
    })
  })

  it('completes bootstrap when loyalty points never expire', async () => {
    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings(null) })),
      { get: () => identity },
      syncAllowed,
      {
        persistSnapshot: (resource) => {
          expect(resource.loyalty?.points_expire_after_days).toBeNull()

          return { snapshotVersion: 'x', serverTime: '2026-01-01T00:00:00Z', counts: {} }
        }
      }
    )

    await expect(service.refresh()).resolves.toMatchObject({ isComplete: true })
  })

  it('preserves a positive loyalty expiry during bootstrap parsing', async () => {
    let persisted = false

    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings(30) })),
      { get: () => identity },
      syncAllowed,
      {
        persistSnapshot: (resource) => {
          persisted = true
          expect(resource.loyalty?.points_expire_after_days).toBe(30)

          return { snapshotVersion: 'x', serverTime: '2026-01-01T00:00:00Z', counts: {} }
        }
      }
    )

    await expect(service.refresh()).resolves.toMatchObject({ isComplete: true })
    expect(persisted).toBe(true)
  })

  it('coalesces concurrent refresh calls into one validated publication attempt', async () => {
    let requests = 0
    let persistCalls = 0
    let resolveResponse: (value: unknown) => void = () => {
      throw new Error('The deferred bootstrap response has not been initialized.')
    }
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve
    })
    const apiClient = {
      request: () => {
        requests += 1
        return response
      }
    } as unknown as DesktopApiClient
    const service = new BootstrapService(apiClient, { get: () => identity }, syncAllowed, {
      persistSnapshot: () => {
        persistCalls += 1
        return { snapshotVersion: 'x', serverTime: '2026-01-01T00:00:00Z', counts: {} }
      }
    })

    const first = service.refresh()
    const second = service.refresh()
    expect(first).toBe(second)
    resolveResponse(desktopBootstrapFixture())

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(requests).toBe(1)
    expect(persistCalls).toBe(1)
  })

  it('maps an invalid bootstrap payload to a non-retryable public error without partial completion', async () => {
    let persisted = false
    const originalTraceSetting = process.env.POS_API_TRACE
    process.env.POS_API_TRACE = '1'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings('never') })),
      { get: () => identity },
      syncAllowed,
      {
        persistSnapshot: () => {
          persisted = true
          return { snapshotVersion: 'x', serverTime: 'x', counts: {} }
        }
      }
    )

    try {
      await expect(service.refresh()).rejects.toMatchObject({
        category: 'unexpected',
        message:
          'The service returned unsupported bootstrap data. Please update the desktop application or contact support.',
        backendCode: 'bootstrap_payload_contract_invalid',
        retryable: false
      })

      const traceLine = consoleError.mock.calls
        .map(([line]) => line)
        .find(
          (line): line is string =>
            typeof line === 'string' && line.includes('bootstrap_payload_contract_invalid')
        )

      expect(traceLine).toBe(
        '[pos-api] category=bootstrap_payload_contract_invalid field_path=loyalty.points_expire_after_days'
      )
      expect(persisted).toBe(false)
    } finally {
      consoleError.mockRestore()

      if (originalTraceSetting === undefined) {
        delete process.env.POS_API_TRACE
      } else {
        process.env.POS_API_TRACE = originalTraceSetting
      }
    }
  })
})
