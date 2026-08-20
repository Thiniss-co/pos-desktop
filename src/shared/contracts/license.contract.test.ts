import { describe, expect, it } from 'vitest'
import { commercialAccessSnapshotSchema } from './license.contract'

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
