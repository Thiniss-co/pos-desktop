import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import {
  COMMERCIAL_ACCESS_REASON_CLASSIFICATION,
  commercialAccessReasonSchema,
  type CommercialAccessReason,
  type LicenseStatus
} from '@shared/contracts/license.contract'
import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../repositories/licenseMetadata.repository'
import { CommercialAccessService } from './commercialAccess.service'

function validLicense(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    restrictionLevel: 'none',
    canSell: true,
    canSync: true,
    isActive: true,
    isInGrace: false,
    isExpired: false,
    expiresAt: '2026-01-04T00:00:00Z',
    warningMessage: null,
    validatedAt: '2026-01-01T00:00:00Z',
    serverTime: '2026-01-01T00:00:00Z',
    nextValidationDueAt: '2026-01-04T00:00:00Z',
    maxOfflineHours: 72,
    subscription: { status: 'active', expiresAt: null, graceEndsAt: null },
    ...overrides
  }
}

function onlineSnapshot(): ConnectivitySnapshot {
  return {
    status: 'online',
    networkAvailable: true,
    backendReachable: true,
    checkedAt: '2026-01-01T12:00:00Z',
    lastBackendReachableAt: '2026-01-01T12:00:00Z',
    reason: 'probe_succeeded'
  }
}

interface State {
  now: string
  license: LicenseStatus | null
  anchor: string | null
  device: { status: string } | null
  authenticated: boolean
  company: { isActive: boolean } | null
  posEnabled: boolean
  hasSellPermission: boolean
  connectivity: ConnectivitySnapshot
}

function validState(): State {
  return {
    now: '2026-01-01T12:00:00Z',
    license: validLicense(),
    anchor: '2026-01-01T12:00:00Z',
    device: { status: 'active' },
    authenticated: true,
    company: { isActive: true },
    posEnabled: true,
    hasSellPermission: true,
    connectivity: onlineSnapshot()
  }
}

function createService(overrides: Partial<State> = {}): {
  service: CommercialAccessService
  state: State
} {
  const state = { ...validState(), ...overrides }
  const session = (): SessionSummary => ({
    isAuthenticated: state.authenticated,
    userName: state.authenticated ? 'Cashier' : null,
    userEmail: state.authenticated ? 'cashier@example.test' : null
  })

  return {
    state,
    service: new CommercialAccessService({
      session: { getSummary: session },
      licenseMetadata: { getStatus: () => state.license },
      permissions: {
        hasPermission: (permission) => permission === 'pos.sell' && state.hasSellPermission
      },
      settings: { get: (key) => (key === LICENSE_TRUSTED_TIME_ANCHOR_KEY ? state.anchor : null) },
      devices: { get: () => state.device },
      company: { getCompany: () => state.company },
      features: { isFeatureEnabled: (code) => code === 'pos' && state.posEnabled },
      connectivity: { getSnapshot: () => state.connectivity },
      now: () => new Date(state.now)
    })
  }
}

function reasonFor(
  service: CommercialAccessService,
  action: 'sell' | 'sync'
): CommercialAccessReason | null {
  return service.evaluate(action).reason
}

describe('CommercialAccessService', () => {
  it('keeps sell and sync grants independent and exposes only safe decisions', () => {
    const sellOnly = createService({
      license: validLicense({ canSell: true, canSync: false })
    }).service
    const syncOnly = createService({
      license: validLicense({ canSell: false, canSync: true })
    }).service

    expect(sellOnly.evaluate('sell')).toMatchObject({
      allowed: true,
      action: 'sell',
      nextValidationDueAt: '2026-01-04T00:00:00Z',
      restrictionLevel: 'none'
    })
    expect(reasonFor(sellOnly, 'sync')).toBe('license-denied')
    expect(reasonFor(syncOnly, 'sell')).toBe('license-denied')
    expect(syncOnly.evaluate('sync').allowed).toBe(true)
  })

  it('evaluates the fail-closed guard in the documented order', () => {
    const { service, state } = createService({
      device: null,
      authenticated: false,
      license: null,
      anchor: '2026-01-02T00:00:00Z',
      company: null,
      posEnabled: false,
      hasSellPermission: false,
      connectivity: {
        ...onlineSnapshot(),
        status: 'offline',
        networkAvailable: false,
        backendReachable: null,
        reason: 'network_offline'
      }
    })
    const expected: CommercialAccessReason[] = [
      'device-not-registered',
      'device-revoked',
      'device-blocked',
      'session-invalid',
      'license-state-invalid',
      'clock-untrusted',
      'grace-ended',
      'validation-overdue',
      'bootstrap-incomplete',
      'company-inactive',
      'feature-not-enabled',
      'license-denied',
      'permission-denied'
    ]

    expect(reasonFor(service, 'sell')).toBe(expected[0])
    state.device = { status: 'revoked' }
    expect(reasonFor(service, 'sell')).toBe(expected[1])
    state.device = { status: 'blocked_login' }
    expect(reasonFor(service, 'sell')).toBe(expected[2])
    state.device = { status: 'active' }
    expect(reasonFor(service, 'sell')).toBe(expected[3])
    state.authenticated = true
    expect(reasonFor(service, 'sell')).toBe(expected[4])
    state.license = validLicense()
    expect(reasonFor(service, 'sell')).toBe(expected[5])
    state.anchor = state.now
    state.license = validLicense({
      subscription: {
        status: 'expired',
        expiresAt: '2026-01-01T00:00:00Z',
        graceEndsAt: '2026-01-01T12:00:00Z'
      }
    })
    expect(reasonFor(service, 'sell')).toBe(expected[6])
    state.license = validLicense({ nextValidationDueAt: state.now })
    expect(reasonFor(service, 'sell')).toBe(expected[7])
    state.license = validLicense()
    expect(reasonFor(service, 'sell')).toBe(expected[8])
    state.company = { isActive: false }
    expect(reasonFor(service, 'sell')).toBe(expected[9])
    state.company = { isActive: true }
    expect(reasonFor(service, 'sell')).toBe(expected[10])
    state.posEnabled = true
    state.license = validLicense({ canSell: false })
    expect(reasonFor(service, 'sell')).toBe(expected[11])
    state.license = validLicense()
    expect(reasonFor(service, 'sell')).toBe(expected[12])
  })

  it('applies the device matrix and fails closed for an unknown device status', () => {
    const cases: Array<[string, CommercialAccessReason | null, CommercialAccessReason | null]> = [
      ['active', null, null],
      ['blocked_login', 'device-blocked', 'device-blocked'],
      ['blocked_selling', 'device-blocked', null],
      ['blocked_sync', null, 'device-blocked'],
      ['revoked', 'device-revoked', 'device-revoked'],
      ['retired', 'device-revoked', 'device-revoked'],
      ['future-status', 'device-blocked', 'device-blocked']
    ]

    for (const [status, sellReason, syncReason] of cases) {
      const { service } = createService({ device: { status } })
      expect(reasonFor(service, 'sell')).toBe(sellReason)
      expect(reasonFor(service, 'sync')).toBe(syncReason)
    }
  })

  it('denies deadline and grace boundaries at their exact instant', () => {
    const beforeDeadline = createService({ now: '2026-01-03T23:59:59.999Z' }).service
    const atDeadline = createService({ now: '2026-01-04T00:00:00Z' }).service
    const graceLicense = validLicense({
      subscription: {
        status: 'grace',
        expiresAt: '2026-01-01T00:00:00Z',
        graceEndsAt: '2026-01-03T00:00:00Z'
      }
    })
    const inGrace = createService({
      license: graceLicense,
      now: '2026-01-02T23:59:59.999Z'
    }).service
    const atGraceEnd = createService({ license: graceLicense, now: '2026-01-03T00:00:00Z' }).service

    expect(beforeDeadline.evaluate('sell')).toMatchObject({
      allowed: true,
      warning: 'validation-due-soon'
    })
    expect(reasonFor(atDeadline, 'sell')).toBe('validation-overdue')
    expect(inGrace.evaluate('sync')).toMatchObject({ allowed: true, warning: 'grace' })
    expect(reasonFor(atGraceEnd, 'sync')).toBe('grace-ended')
  })

  it('does not let connectivity mask an earlier denial or grant a sell', () => {
    let reads = 0
    const { service, state } = createService({
      device: null,
      connectivity: {
        ...onlineSnapshot(),
        status: 'offline',
        networkAvailable: false,
        backendReachable: null,
        reason: 'network_offline'
      }
    })
    const noReadService = new CommercialAccessService({
      session: {
        getSummary: () => ({
          isAuthenticated: true,
          userName: 'Cashier',
          userEmail: 'cashier@example.test'
        })
      },
      licenseMetadata: { getStatus: () => validLicense() },
      permissions: { hasPermission: () => true },
      settings: { get: () => '2026-01-01T12:00:00Z' },
      devices: { get: () => null },
      company: { getCompany: () => ({ isActive: true }) },
      features: { isFeatureEnabled: () => true },
      connectivity: {
        getSnapshot: () => {
          reads += 1
          return onlineSnapshot()
        }
      },
      now: () => new Date('2026-01-01T12:00:00Z')
    })

    expect(reasonFor(noReadService, 'sync')).toBe('device-not-registered')
    expect(reads).toBe(0)
    expect(reasonFor(service, 'sell')).toBe('device-not-registered')
    state.device = { status: 'active' }
    expect(service.evaluate('sell').allowed).toBe(true)
    expect(reasonFor(service, 'sync')).toBe('connectivity-unavailable')
  })

  it('allows a checking connectivity snapshot so first bootstrap can reach the transport layer', () => {
    const { service } = createService({
      company: null,
      connectivity: {
        ...onlineSnapshot(),
        status: 'checking',
        networkAvailable: null,
        backendReachable: null,
        reason: 'startup'
      }
    })

    expect(service.evaluate('sync').allowed).toBe(true)
  })

  it('classifies every denial consistently for thrown public errors', () => {
    expect(Object.keys(COMMERCIAL_ACCESS_REASON_CLASSIFICATION).sort()).toEqual(
      [...commercialAccessReasonSchema.options].sort()
    )

    const cases: Array<[CommercialAccessReason, Partial<State>, 'sell' | 'sync']> = [
      ['device-not-registered', { device: null }, 'sell'],
      ['device-revoked', { device: { status: 'revoked' } }, 'sell'],
      ['device-blocked', { device: { status: 'blocked_login' } }, 'sell'],
      ['session-invalid', { authenticated: false }, 'sell'],
      ['clock-untrusted', { anchor: '2026-01-02T00:00:00Z' }, 'sell'],
      ['license-state-invalid', { license: null }, 'sell'],
      [
        'grace-ended',
        {
          license: validLicense({
            subscription: {
              status: 'expired',
              expiresAt: '2026-01-01T00:00:00Z',
              graceEndsAt: null
            }
          })
        },
        'sell'
      ],
      ['validation-overdue', { now: '2026-01-04T00:00:00Z' }, 'sell'],
      ['license-denied', { license: validLicense({ canSell: false }) }, 'sell'],
      ['permission-denied', { hasSellPermission: false }, 'sell'],
      ['bootstrap-incomplete', { company: null }, 'sell'],
      ['company-inactive', { company: { isActive: false } }, 'sell'],
      ['feature-not-enabled', { posEnabled: false }, 'sell'],
      [
        'connectivity-unavailable',
        {
          connectivity: {
            ...onlineSnapshot(),
            status: 'offline',
            networkAvailable: false,
            backendReachable: null,
            reason: 'network_offline'
          }
        },
        'sync'
      ]
    ]

    for (const [reason, state, action] of cases) {
      const { service } = createService(state)
      const classification = COMMERCIAL_ACCESS_REASON_CLASSIFICATION[reason]

      expect(() => service.assertAllowed(action)).toThrow(
        expect.objectContaining({
          category: classification.category,
          retryable: classification.retryable,
          backendCode: `COMMERCIAL_ACCESS_${reason.replaceAll('-', '_').toUpperCase()}`
        })
      )
    }
  })
})
