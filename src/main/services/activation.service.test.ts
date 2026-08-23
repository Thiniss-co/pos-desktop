import { describe, expect, it } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import { ActivationService } from './activation.service'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status < 400,
      status,
      json: async () => payload
    }) as Response) as unknown as typeof fetch
}

const identity: StoredDeviceIdentity = {
  deviceUuid: '00000000-0000-4000-8000-000000000001',
  deviceName: 'Register One',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: false
}

function successEnvelope(): Record<string, unknown> {
  return {
    success: true,
    message: 'Device registered successfully.',
    code: 'DEVICE_REGISTERED',
    data: {
      id: 'server-device-uuid',
      device_uuid: identity.deviceUuid,
      device_name: identity.deviceName,
      platform: identity.platform,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z'
    },
    meta: {}
  }
}

describe('ActivationService', () => {
  it('registers using the main-owned identity, never the renderer-provided uuid', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: (async (_url: unknown, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
        return { ok: true, status: 201, json: async () => successEnvelope() } as Response
      }) as unknown as typeof fetch
    })

    let markedRegisteredAt: string | undefined
    let registrationRecord: { serverDeviceId: string; status: string } | undefined

    const service = new ActivationService(
      { transaction: (fn) => () => fn() },
      {
        get: () => identity,
        markRegisteredWithBackend: (timestamp) => {
          markedRegisteredAt = timestamp
        }
      },
      {
        set: (record) => {
          registrationRecord = record
        }
      },
      apiClient
    )

    const result = await service.register({
      companyCode: 'ACME',
      activationCode: 'super-secret-code',
      deviceName: 'Front Register'
    })

    expect(capturedBody?.device_uuid).toBe(identity.deviceUuid)
    expect(capturedBody?.company_code).toBe('ACME')
    expect(capturedBody?.fingerprint_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(capturedBody).not.toHaveProperty('activation_code_hash')
    expect(result.isRegistered).toBe(true)
    expect(result.deviceUuid).toBe(identity.deviceUuid)
    expect(markedRegisteredAt).toBeDefined()
    expect(registrationRecord?.serverDeviceId).toBe('server-device-uuid')

    // The activation code must never appear in any persisted or returned artifact.
    expect(JSON.stringify(result)).not.toContain('super-secret-code')
    expect(JSON.stringify(registrationRecord)).not.toContain('super-secret-code')
  })

  it('rejects when local device identity has not been initialized', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: fakeFetch(successEnvelope())
    })

    const service = new ActivationService(
      { transaction: (fn) => () => fn() },
      { get: () => null, markRegisteredWithBackend: () => undefined },
      { set: () => undefined },
      apiClient
    )

    await expect(service.register({ companyCode: 'ACME', activationCode: 'code' })).rejects.toThrow(
      'Local device identity is not initialized'
    )
  })

  it('surfaces a device-limit denial as an authorization error, not a transport failure, and persists nothing', async () => {
    // Regression test for the reported activation bug reproduced against the real backend: a
    // company that has already reached its plan's device limit rejects new registrations with
    // 403 FORBIDDEN and `errors: null`. Before the envelope schema fix, this was misclassified
    // as a generic retryable "transport" failure ("The desktop service request failed"),
    // masking the real, actionable denial reason.
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: fakeFetch(
        {
          success: false,
          message: 'The device limit for this plan has been reached.',
          code: 'FORBIDDEN',
          errors: null,
          meta: { trace_id: 'trace-device-limit', access: { can_activate_device: false } }
        },
        403
      )
    })

    let transactionRan = false
    const service = new ActivationService(
      {
        transaction: (fn) => () => {
          transactionRan = true
          fn()
        }
      },
      { get: () => identity, markRegisteredWithBackend: () => undefined },
      { set: () => undefined },
      apiClient
    )

    await expect(
      service.register({ companyCode: 'ACME', activationCode: 'super-secret-code' })
    ).rejects.toMatchObject({
      category: 'authorization',
      retryable: false,
      backendCode: 'FORBIDDEN'
    })
    expect(transactionRan).toBe(false)
  })
})
