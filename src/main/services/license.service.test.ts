import { describe, expect, it, vi } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import { licenseStatusSchema, type LicenseStatus } from '@shared/contracts/license.contract'
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

  it('accepts a real backend payload whose timestamps carry a UTC offset instead of Z', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => 'device-uuid',
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          const envelope = licenseSuccessEnvelope()
          const data = envelope.data as Record<string, unknown>
          data.expires_at = '2026-08-26T14:21:41+00:00'
          data.server_time = '2026-08-23T14:21:41+00:00'
          data.last_validated_at = '2026-08-23T14:21:41+00:00'
          data.next_validation_due_at = '2026-08-26T14:21:41+00:00'
          data.subscription = {
            status: 'active',
            expires_at: '2026-09-29T13:07:59+00:00',
            grace_ends_at: '2026-10-07T13:07:59+00:00'
          }
          return envelope
        }
      })) as unknown as typeof fetch
    })

    const secrets = new Map<string, string>()
    let storedStatus: unknown

    const service = new LicenseService(
      apiClient,
      {
        getTrustedTimeAnchor: () => null,
        setValidatedStatus: (status) => {
          storedStatus = status
        }
      },
      { setSecret: (key, value) => secrets.set(key, value) },
      () => new Date('2026-08-23T14:21:41Z')
    )

    const status = await service.validate()

    expect(status.serverTime).toBe('2026-08-23T14:21:41+00:00')
    expect(storedStatus).toEqual(status)
    expect(secrets.get(DESKTOP_LICENSE_JWT_KEY)).toBe('signed.jwt.value-should-never-leak')
  })

  it('Phase 4 closeout: keeps a covered renewal in the stored status and drops a malformed one', async () => {
    const run = async (coverage: unknown): Promise<unknown> => {
      const apiClient = new DesktopApiClient({
        apiOrigin: new URL('https://api.example.test'),
        getAccessToken: () => 'token',
        getDeviceUuid: () => 'device-uuid',
        fetchImplementation: (async () => ({
          ok: true,
          status: 200,
          json: async () => {
            const envelope = licenseSuccessEnvelope()
            const data = envelope.data as Record<string, unknown>
            data.subscription = {
              status: 'active',
              expires_at: '2026-10-07T12:00:00+00:00',
              grace_ends_at: '2026-10-14T12:00:00+00:00',
              offline_coverage: coverage
            }
            return envelope
          }
        })) as unknown as typeof fetch
      })
      let storedStatus: unknown
      await new LicenseService(
        apiClient,
        {
          getTrustedTimeAnchor: () => null,
          setValidatedStatus: (status) => (storedStatus = status)
        },
        { setSecret: () => undefined },
        () => new Date('2026-10-07T10:00:00Z')
      ).validate()
      return storedStatus
    }

    const stored = (await run({
      renewal_id: 'b6f1c7a8-9d0e-4f1a-8b2c-3d4e5f607182',
      starts_at: '2026-10-07T12:00:00+00:00',
      expires_at: '2026-11-07T12:00:00+00:00',
      grace_ends_at: '2026-11-14T12:00:00+00:00'
    })) as LicenseStatus
    expect(stored.subscription?.offlineCoverage).toEqual({
      renewalId: 'b6f1c7a8-9d0e-4f1a-8b2c-3d4e5f607182',
      startsAt: '2026-10-07T12:00:00+00:00',
      expiresAt: '2026-11-07T12:00:00+00:00',
      graceEndsAt: '2026-11-14T12:00:00+00:00'
    })
    // What the metadata repository writes and reads back after a restart (JSON + the strict schema).
    expect(licenseStatusSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored)

    const malformed = (await run({ renewal_id: 'x', starts_at: 'not-a-date' })) as LicenseStatus
    expect(malformed.subscription?.offlineCoverage).toBeNull()
    const absent = (await run(undefined)) as LicenseStatus
    expect(absent.subscription?.offlineCoverage).toBeNull()
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

describe('LicenseService — Rev 4 renewal leg', () => {
  const OWNER = {
    sessionEpoch: 3,
    userUuid: '11111111-1111-4111-8111-111111111111',
    userIsActive: true,
    companyUuid: '22222222-2222-4222-8222-222222222222',
    deviceUuid: '33333333-3333-4333-8333-333333333333',
    serverDeviceId: '44444444-4444-4444-8444-444444444444',
    branchUuid: '55555555-5555-4555-8555-555555555555',
    warehouseUuid: '66666666-6666-4666-8666-666666666666'
  }
  const AUTHORITY_V2 = {
    id: '77777777-7777-4777-8777-777777777777',
    mode: 'physical_presence',
    policy_revision: 1,
    contract_version: 3,
    issued_at: '2026-01-01T00:00:00+00:00',
    not_before: '2026-01-01T00:00:00+00:00',
    not_after: '2026-01-04T00:00:00+00:00',
    authority_hash: 'a'.repeat(64),
    warehouse_uuid: OWNER.warehouseUuid
  }

  function harness(options: {
    readonly responses: Array<{ status: number; body: Record<string, unknown> }>
    readonly ownerDuringWrite?: () => typeof OWNER | null
  }): {
    service: LicenseService
    bodies: unknown[]
    secrets: Map<string, string>
    statuses: unknown[]
    observed: unknown[]
    transactions: () => number
  } {
    const bodies: unknown[] = []
    let call = 0
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => 'device-uuid',
      fetchImplementation: (async (_url: unknown, init: { body?: string }) => {
        bodies.push(init.body ? JSON.parse(init.body) : undefined)
        const response = options.responses[Math.min(call, options.responses.length - 1)]
        call += 1
        return {
          ok: response.status < 400,
          status: response.status,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => response.body
        }
      }) as unknown as typeof fetch
    })
    const secrets = new Map<string, string>()
    const statuses: unknown[] = []
    const observed: unknown[] = []
    let transactions = 0
    let ownerReads = 0
    const service = new LicenseService(
      apiClient,
      {
        getTrustedTimeAnchor: () => null,
        setValidatedStatus: (status) => {
          statuses.push(status)
        }
      },
      { setSecret: (key, value) => secrets.set(key, value) },
      () => new Date('2026-01-01T00:00:00Z'),
      {
        database: {
          transaction:
            <T>(fn: () => T) =>
            () => {
              transactions += 1
              return fn()
            }
        },
        owner: () => {
          ownerReads += 1
          if (ownerReads === 1 || !options.ownerDuringWrite) {
            return OWNER
          }
          return options.ownerDuringWrite()
        },
        offlineSaleAuthorities: {
          observe: (published, companyUuid, deviceUuid) => {
            observed.push({ published, companyUuid, deviceUuid })
            return {} as never
          }
        }
      }
    )
    return { service, bodies, secrets, statuses, observed, transactions: () => transactions }
  }

  function withAuthority(authority: Record<string, unknown>): Record<string, unknown> {
    const envelope = licenseSuccessEnvelope()
    return {
      ...envelope,
      data: { ...(envelope.data as object), offline_sale_authority: authority }
    }
  }

  it('negotiates v2 and stores the published authority for the captured owner in one transaction', async () => {
    const h = harness({ responses: [{ status: 200, body: withAuthority(AUTHORITY_V2) }] })

    await h.service.validate()

    expect(h.bodies).toEqual([
      { offline_sale_contract_version: 2, offline_coverage_version: 1, access_sequence_version: 1 }
    ])
    expect(h.transactions()).toBe(1)
    expect(h.secrets.get(DESKTOP_LICENSE_JWT_KEY)).toBeTruthy()
    expect(h.statuses).toHaveLength(1)
    expect(h.observed).toEqual([
      { published: AUTHORITY_V2, companyUuid: OWNER.companyUuid, deviceUuid: OWNER.deviceUuid }
    ])
  })

  it.each([
    ['sign-out', () => null],
    [
      'another user',
      () => ({ ...OWNER, userUuid: '99999999-9999-4999-8999-999999999999', sessionEpoch: 4 })
    ],
    [
      'a binding refresh without an epoch bump',
      () => ({ ...OWNER, serverDeviceId: '88888888-8888-4888-8888-888888888888' })
    ],
    ['a reassignment', () => ({ ...OWNER, warehouseUuid: '12121212-1212-4121-8121-121212121212' })]
  ])('discards the whole result when the owner changed in flight (%s)', async (_label, during) => {
    const h = harness({
      responses: [{ status: 200, body: withAuthority(AUTHORITY_V2) }],
      ownerDuringWrite: during as () => typeof OWNER | null
    })

    await expect(h.service.validate()).rejects.toMatchObject({ code: 'owner-changed' })

    expect(h.secrets.size).toBe(0)
    expect(h.statuses).toHaveLength(0)
    expect(h.observed).toHaveLength(0)
  })

  it('falls back to v1 once when an older backend rejects the negotiated version', async () => {
    const { warehouse_uuid: _dropped, ...v1 } = AUTHORITY_V2
    void _dropped
    const h = harness({
      responses: [
        {
          status: 422,
          body: {
            success: false,
            message: 'The given data was invalid.',
            code: 'VALIDATION_ERROR',
            errors: { offline_sale_contract_version: ['The selected version is invalid.'] },
            meta: { trace_id: 'trace' }
          }
        },
        { status: 200, body: withAuthority(v1) }
      ]
    })

    await h.service.validate()
    await h.service.validate()

    expect(h.bodies).toEqual([
      { offline_sale_contract_version: 2, offline_coverage_version: 1, access_sequence_version: 1 },
      { offline_sale_contract_version: 1, offline_coverage_version: 1, access_sequence_version: 1 },
      { offline_sale_contract_version: 1, offline_coverage_version: 1, access_sequence_version: 1 }
    ])
    expect((h.observed[0] as { published: Record<string, unknown> }).published).not.toHaveProperty(
      'warehouse_uuid'
    )
  })
})

describe('LicenseService secure storage', () => {
  it('fails closed before the licence is requested when it could not be stored protected', async () => {
    const fetchImplementation = vi.fn()
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'token',
      getDeviceUuid: () => 'device',
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    })
    const setValidatedStatus = vi.fn()
    const setSecret = vi.fn()
    const refusal = { category: 'configuration', backendCode: 'SECURE_STORAGE_INSECURE_BACKEND' }

    await expect(
      new LicenseService(
        apiClient,
        { getTrustedTimeAnchor: () => null, setValidatedStatus },
        {
          setSecret,
          assertCanPersistSecrets: () => {
            throw refusal
          }
        }
      ).validate()
    ).rejects.toBe(refusal)
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(setSecret).not.toHaveBeenCalled()
    expect(setValidatedStatus).not.toHaveBeenCalled()
  })
})
