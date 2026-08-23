import { describe, expect, it } from 'vitest'
import { commercialAccessSnapshotSchema, licenseStatusSchema } from './license.contract'

function licenseStatusFixture(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    restrictionLevel: 'allow_all',
    canSell: true,
    canSync: true,
    isActive: true,
    isInGrace: false,
    isExpired: false,
    expiresAt: '2026-08-26T14:21:41+00:00',
    warningMessage: null,
    validatedAt: '2026-08-23T14:21:41+00:00',
    serverTime: '2026-08-23T14:21:41+00:00',
    nextValidationDueAt: '2026-08-26T14:21:41+00:00',
    maxOfflineHours: 72,
    subscription: {
      status: 'active',
      expiresAt: '2026-09-29T13:07:59+00:00',
      graceEndsAt: '2026-10-07T13:07:59+00:00'
    },
    ...overrides
  }
}

describe('licenseStatusSchema', () => {
  it('accepts Laravel-style ISO-8601 timestamps with a UTC offset', () => {
    expect(licenseStatusSchema.safeParse(licenseStatusFixture()).success).toBe(true)
  })

  it('still accepts Z-suffixed timestamps', () => {
    expect(
      licenseStatusSchema.safeParse(
        licenseStatusFixture({
          validatedAt: '2026-08-23T14:21:41Z',
          serverTime: '2026-08-23T14:21:41Z',
          nextValidationDueAt: '2026-08-26T14:21:41Z'
        })
      ).success
    ).toBe(true)
  })

  it('rejects a non-timestamp string', () => {
    expect(
      licenseStatusSchema.safeParse(licenseStatusFixture({ serverTime: 'not-a-date' })).success
    ).toBe(false)
  })
})

describe('commercial access IPC contract', () => {
  it('exposes only action decisions suitable for renderer display', () => {
    expect(
      commercialAccessSnapshotSchema.safeParse({
        sell: { allowed: false, reason: 'license-denied', warning: null },
        sync: { allowed: true, reason: null, warning: 'validation-due-soon' }
      }).success
    ).toBe(true)
  })

  it('rejects secrets and raw license metadata from the renderer-facing snapshot', () => {
    expect(
      commercialAccessSnapshotSchema.safeParse({
        sell: { allowed: true, reason: null, warning: null },
        sync: { allowed: true, reason: null, warning: null },
        token: 'signed-jwt',
        nextValidationDueAt: '2026-01-04T00:00:00Z'
      }).success
    ).toBe(false)
  })
})
