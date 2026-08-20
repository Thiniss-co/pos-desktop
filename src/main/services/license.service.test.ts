import { describe, expect, it } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import { DESKTOP_LICENSE_JWT_KEY, LicenseService } from './license.service'

function licenseSuccessEnvelope(): Record<string, unknown> {
  return {
    success: true,
    message: 'License validated successfully.',
    code: 'LICENSE_VALIDATED',
    data: {
      token: 'signed.jwt.value-should-never-leak',
      expires_at: '2026-01-04T00:00:00Z',
      server_time: '2026-01-01T00:00:00Z',
      last_validated_at: '2026-01-01T00:00:00Z',
      next_validation_due_at: '2026-01-04T00:00:00Z',
      max_offline_hours: 72,
      subscription: {
        status: 'active',
        expires_at: null,
        grace_ends_at: null
      },
      access: {
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: false,
        can_login: true,
        can_sell: true,
        can_sync: true,
        can_activate_device: true,
        restriction_level: 'none',
        warning_message: null
      }
    },
    meta: {}
  }
}

describe('LicenseService', () => {
  it('encrypts the JWT and only returns sanitized status fields', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => 'device-uuid',
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => licenseSuccessEnvelope()
      })) as unknown as typeof fetch
    })

    const secrets = new Map<string, string>()
    let storedStatus: unknown
    let trustedTimeAnchor: string | null = null

    const service = new LicenseService(
      apiClient,
      {
        getTrustedTimeAnchor: () => trustedTimeAnchor,
        setValidatedStatus: (status, anchor) => {
          storedStatus = status
          trustedTimeAnchor = anchor
        }
      },
      {
        setSecret: (key, value) => {
          secrets.set(key, value)
        }
      },
      () => new Date('2026-01-01T01:00:00Z')
    )

    const status = await service.validate()

    expect(status).toMatchObject({
      restrictionLevel: 'none',
      canSell: true,
      canSync: true,
      isActive: true
    })
    expect(JSON.stringify(status)).not.toContain('signed.jwt.value-should-never-leak')
    expect(secrets.get(DESKTOP_LICENSE_JWT_KEY)).toBe('signed.jwt.value-should-never-leak')
    expect(storedStatus).toEqual(status)
    expect(trustedTimeAnchor).toBe('2026-01-01T01:00:00.000Z')
  })

  it('does not advance cached commercial access after an invalid license response', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => 'device-uuid',
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          const envelope = licenseSuccessEnvelope()
          delete (envelope.data as Record<string, unknown>).next_validation_due_at
          return envelope
        }
      })) as unknown as typeof fetch
    })
    let writes = 0
    const secrets = new Map<string, string>()
    const service = new LicenseService(
      apiClient,
      {
        getTrustedTimeAnchor: () => '2026-01-01T00:00:00Z',
        setValidatedStatus: () => {
          writes += 1
        }
      },
      { setSecret: (key, value) => secrets.set(key, value) }
    )

    await expect(service.validate()).rejects.toMatchObject({
      category: 'unexpected',
      backendCode: 'license_payload_contract_invalid',
      retryable: false
    })
    expect(writes).toBe(0)
    expect(secrets.has(DESKTOP_LICENSE_JWT_KEY)).toBe(false)
  })
})
