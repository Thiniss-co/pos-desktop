import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { LicenseStatus } from '@shared/contracts/license.contract'
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

function createService(
  options: {
    now?: string
    license?: LicenseStatus | null
    authenticated?: boolean
    canSell?: boolean
    anchor?: string | null
  } = {}
): CommercialAccessService {
  const session: SessionSummary = {
    isAuthenticated: options.authenticated ?? true,
    userName: 'Cashier',
    userEmail: 'cashier@example.test'
  }
  const state = {
    license: options.license === undefined ? validLicense() : options.license,
    anchor: options.anchor === undefined ? '2026-01-01T12:00:00Z' : options.anchor,
    canSell: options.canSell ?? true
  }

  return new CommercialAccessService(
    { getSummary: () => session },
    { getStatus: () => state.license },
    { hasPermission: (permission) => permission === 'pos.sell' && state.canSell },
    { get: (key) => (key === LICENSE_TRUSTED_TIME_ANCHOR_KEY ? state.anchor : null) },
    () => new Date(options.now ?? '2026-01-01T12:00:00Z')
  )
}

describe('CommercialAccessService', () => {
  it('allows only the explicit license grants and persisted sell permission', () => {
    const service = createService({
      license: validLicense({ canSell: false, canSync: true, isInGrace: true })
    })

    expect(service.describe()).toEqual({
      sell: { allowed: false, reason: 'license-denied', warning: null },
      sync: { allowed: true, reason: null, warning: null }
    })
    expect(() => service.assertCanSell()).toThrow('This workstation is not permitted')
    expect(() => service.assertCanSync()).not.toThrow()
  })

  it('enforces the validation deadline at its exact instant', () => {
    const beforeDeadline = createService({ now: '2026-01-03T23:59:59Z' })
    const atDeadline = createService({ now: '2026-01-04T00:00:00Z' })

    expect(beforeDeadline.describe().sell).toEqual({
      allowed: true,
      reason: null,
      warning: 'validation-due-soon'
    })
    expect(atDeadline.describe().sell).toEqual({
      allowed: false,
      reason: 'validation-overdue',
      warning: null
    })
  })

  it('permits a valid grace window but denies at its exact end', () => {
    const license = validLicense({
      subscription: {
        status: 'grace',
        expiresAt: '2026-01-01T00:00:00Z',
        graceEndsAt: '2026-01-03T00:00:00Z'
      }
    })
    const inGrace = createService({ license, now: '2026-01-02T00:00:00Z' })
    const afterGrace = createService({ license, now: '2026-01-03T00:00:00Z' })

    expect(inGrace.describe().sell).toEqual({ allowed: true, reason: null, warning: 'grace' })
    expect(afterGrace.describe().sync).toEqual({
      allowed: false,
      reason: 'grace-ended',
      warning: null
    })
  })

  it('fails closed for missing and contradictory license state', () => {
    const missing = createService({ license: null })
    const contradictory = createService({
      license: validLicense({
        subscription: {
          status: 'active',
          expiresAt: '2026-01-05T00:00:00Z',
          graceEndsAt: '2026-01-04T00:00:00Z'
        }
      })
    })

    expect(missing.describe().sell.reason).toBe('license-state-invalid')
    expect(contradictory.describe().sync.reason).toBe('license-state-invalid')
  })

  it('does not extend access when the workstation clock is rolled back', () => {
    const service = createService({
      now: '2026-01-01T11:58:59Z',
      anchor: '2026-01-01T12:00:00Z'
    })

    expect(service.describe()).toEqual({
      sell: { allowed: false, reason: 'clock-untrusted', warning: null },
      sync: { allowed: false, reason: 'clock-untrusted', warning: null }
    })
  })

  it('requires an authenticated session and pos.sell for selling but not syncing', () => {
    const unauthenticated = createService({ authenticated: false })
    const noSellPermission = createService({ canSell: false })

    expect(unauthenticated.describe().sync.reason).toBe('session-invalid')
    expect(noSellPermission.describe()).toEqual({
      sell: { allowed: false, reason: 'permission-denied', warning: null },
      sync: { allowed: true, reason: null, warning: null }
    })
  })

  it('retains a cached decision when readers are reconstructed from the same persisted values', () => {
    const persistedLicense = validLicense({ canSync: false })
    const persistedAnchor = '2026-01-01T12:00:00Z'
    const firstStart = createService({ license: persistedLicense, anchor: persistedAnchor })
    const restarted = createService({ license: persistedLicense, anchor: persistedAnchor })

    expect(firstStart.describe()).toEqual(restarted.describe())
    expect(restarted.describe().sync.reason).toBe('license-denied')
  })
})
