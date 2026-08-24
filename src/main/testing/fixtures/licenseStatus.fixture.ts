import type { LicenseStatus } from '@shared/contracts/license.contract'

export function licenseStatusFixture(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    restrictionLevel: 'none',
    canSell: true,
    canSync: true,
    isActive: true,
    isInGrace: false,
    isExpired: false,
    expiresAt: null,
    warningMessage: null,
    validatedAt: '2026-01-01T00:00:00+00:00',
    serverTime: '2026-01-01T00:00:00+00:00',
    nextValidationDueAt: '2026-01-04T00:00:00+00:00',
    maxOfflineHours: 72,
    subscription: { status: 'active', expiresAt: null, graceEndsAt: null },
    ...overrides
  }
}
