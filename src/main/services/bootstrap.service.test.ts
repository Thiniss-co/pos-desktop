import { describe, expect, it } from 'vitest'
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
        getStatus: () => ({
          restrictionLevel: 'none',
          canSell: true,
          canSync: true,
          isActive: true,
          isInGrace: false,
          isExpired: false,
          expiresAt: null,
          warningMessage: null,
          validatedAt: '2026-01-01T00:00:00Z'
        })
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

  it('rejects a malformed bootstrap response without persisting or marking complete', async () => {
    let persisted = false
    let marked = false

    const service = new BootstrapService(
      createApiClient({
        success: true,
        message: 'ok',
        code: 'DESKTOP_BOOTSTRAP_RETRIEVED',
        data: { server_time: 'not-a-real-shape' },
        meta: {}
      }),
      { get: () => identity },
      {
        getStatus: () => ({
          restrictionLevel: 'none',
          canSell: true,
          canSync: true,
          isActive: true,
          isInGrace: false,
          isExpired: false,
          expiresAt: null,
          warningMessage: null,
          validatedAt: '2026-01-01T00:00:00Z'
        })
      },
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

    await expect(service.refresh()).rejects.toThrow()
    expect(persisted).toBe(false)
    expect(marked).toBe(false)
  })
})
