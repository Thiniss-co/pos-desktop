import { describe, expect, it, vi } from 'vitest'
import type { LicenseStatus } from '@shared/contracts/license.contract'
import { DesktopApiClient } from '../http/desktopApiClient'
import { BootstrapService } from './bootstrap.service'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

const identity: StoredDeviceIdentity = {
  deviceUuid: '00000000-0000-4000-8000-000000000003',
  deviceName: 'Front Register',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: true
}

function syncEnabledLicense(): LicenseStatus {
  return {
    restrictionLevel: 'none' as const,
    canSell: true,
    canSync: true,
    isActive: true,
    isInGrace: false,
    isExpired: false,
    expiresAt: null,
    warningMessage: null,
    validatedAt: '2026-01-01T00:00:00Z'
  }
}

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
      server_time: '2026-01-01T00:00:00Z',
      company: { id: 'company-uuid', name: 'Acme', is_active: true },
      device: {
        id: 'server-device-uuid',
        device_uuid: identity.deviceUuid,
        device_name: identity.deviceName,
        platform: identity.platform
      },
      license: {
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: false,
        can_login: true,
        can_sell: true,
        can_sync: true,
        can_activate_device: true,
        restriction_level: 'none'
      },
      subscription: null,
      features: { pos: true },
      limits: { users: 5 },
      permissions: ['pos.sell'],
      role: { name: 'cashier' },
      loyalty: null,
      branch: null,
      warehouse: null,
      sync: { snapshot_version: '20260101000000', full_sync_required: true, entities: {} },
      categories: [],
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
      { getStatus: () => null },
      { markComplete: () => undefined },
      { persistSnapshot: () => ({ snapshotVersion: 'x', serverTime: 'x', counts: {} }) }
    )

    await expect(service.refresh()).rejects.toMatchObject({ category: 'authorization' })
  })

  it('blocks with an authorization error when the cached license forbids sync', async () => {
    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope()),
      { get: () => identity },
      {
        getStatus: () => ({
          restrictionLevel: 'suspended',
          canSell: false,
          canSync: false,
          isActive: false,
          isInGrace: false,
          isExpired: true,
          expiresAt: null,
          warningMessage: 'Subscription expired',
          validatedAt: '2026-01-01T00:00:00Z'
        })
      },
      { markComplete: () => undefined },
      { persistSnapshot: () => ({ snapshotVersion: 'x', serverTime: 'x', counts: {} }) }
    )

    await expect(service.refresh()).rejects.toMatchObject({
      category: 'authorization',
      message: 'Subscription expired'
    })
  })

  it('persists the snapshot then marks bootstrap complete, returning sanitized counts', async () => {
    let persistedCalledBefore = false
    let markCompleteCalled = false

    const service = new BootstrapService(
      createApiClient(
        bootstrapSuccessEnvelope({
          categories: [
            { id: '22222222-2222-4222-8222-222222222222', name: 'Drinks', is_active: true }
          ]
        })
      ),
      { get: () => identity },
      {
        getStatus: () => syncEnabledLicense()
      },
      {
        markComplete: () => {
          expect(persistedCalledBefore).toBe(true)
          markCompleteCalled = true
        }
      },
      {
        persistSnapshot: () => {
          persistedCalledBefore = true
          return {
            snapshotVersion: '20260101000000',
            serverTime: '2026-01-01T00:00:00Z',
            counts: { categories: 1 }
          }
        }
      }
    )

    const result = await service.refresh()

    expect(markCompleteCalled).toBe(true)
    expect(result).toEqual({
      isComplete: true,
      snapshotVersion: '20260101000000',
      serverTime: '2026-01-01T00:00:00Z',
      fetchedAt: expect.any(String),
      counts: { categories: 1 }
    })
  })

  it('completes bootstrap when loyalty points never expire', async () => {
    let markCompleteCalls = 0

    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings(null) })),
      { get: () => identity },
      { getStatus: () => syncEnabledLicense() },
      {
        markComplete: () => {
          markCompleteCalls += 1
        }
      },
      {
        persistSnapshot: (resource) => {
          expect(resource.loyalty?.points_expire_after_days).toBeNull()

          return { snapshotVersion: 'x', serverTime: '2026-01-01T00:00:00Z', counts: {} }
        }
      }
    )

    await expect(service.refresh()).resolves.toMatchObject({ isComplete: true })
    expect(markCompleteCalls).toBe(1)
  })

  it('preserves a positive loyalty expiry during bootstrap parsing', async () => {
    let persisted = false

    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings(30) })),
      { get: () => identity },
      { getStatus: () => syncEnabledLicense() },
      { markComplete: () => undefined },
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

  it('maps an invalid bootstrap payload to a non-retryable public error without partial completion', async () => {
    let persisted = false
    let marked = false
    const originalTraceSetting = process.env.POS_API_TRACE
    process.env.POS_API_TRACE = '1'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const service = new BootstrapService(
      createApiClient(bootstrapSuccessEnvelope({ loyalty: loyaltySettings('never') })),
      { get: () => identity },
      { getStatus: () => syncEnabledLicense() },
      {
        markComplete: () => {
          marked = true
        }
      },
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
      expect(marked).toBe(false)
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
