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

    const service = new LicenseService(
      apiClient,
      {
        set: (status) => {
          storedStatus = status
        }
      },
      {
        setSecret: (key, value) => {
          secrets.set(key, value)
        }
      }
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
  })
})
