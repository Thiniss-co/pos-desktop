import { describe, expect, it } from 'vitest'
import { desktopBootstrapResourceSchema } from './desktopResources.contract'

function bootstrapResourceWithExpiry(pointsExpireAfterDays: unknown): Record<string, unknown> {
  return {
    server_time: '2026-01-01T00:00:00Z',
    company: { id: 'company-uuid', name: 'Acme', is_active: true },
    device: {
      id: 'server-device-uuid',
      device_uuid: '00000000-0000-4000-8000-000000000003',
      device_name: 'Front Register',
      platform: 'linux'
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
    loyalty: {
      enabled: true,
      earn_enabled: true,
      redeem_enabled: true,
      points_per_amount: 1,
      amount_per_point: 1,
      minimum_redeem_points: 1,
      maximum_redeem_percent: 100,
      points_expire_after_days: pointsExpireAfterDays,
      points_activate_after_days: 0,
      allow_partial_redemption: true
    },
    branch: null,
    warehouse: null,
    sync: { snapshot_version: '20260101000000', full_sync_required: true, entities: {} }
  }
}

describe('desktopBootstrapResourceSchema loyalty expiry', () => {
  it('accepts null when loyalty points never expire', () => {
    expect(
      desktopBootstrapResourceSchema.safeParse(bootstrapResourceWithExpiry(null)).success
    ).toBe(true)
  })

  it('accepts a positive integer expiry', () => {
    expect(desktopBootstrapResourceSchema.safeParse(bootstrapResourceWithExpiry(30)).success).toBe(
      true
    )
  })

  it.each([
    ['string', '30'],
    ['boolean', true],
    ['decimal', 1.5],
    ['negative number', -1],
    ['zero', 0],
    ['object', {}],
    ['array', []]
  ])('rejects a %s expiry', (_description, expiry) => {
    expect(
      desktopBootstrapResourceSchema.safeParse(bootstrapResourceWithExpiry(expiry)).success
    ).toBe(false)
  })
})
