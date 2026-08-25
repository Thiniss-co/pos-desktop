import { describe, expect, it } from 'vitest'
import { desktopBootstrapFixture } from '../testing/fixtures/desktopBootstrap.fixture'
import { desktopShiftFixture } from '../testing/fixtures/desktopShift.fixture'
import {
  desktopBootstrapResourceSchema,
  desktopShiftResourceSchema
} from './desktopResources.contract'

function bootstrapResourceWithExpiry(pointsExpireAfterDays: unknown): Record<string, unknown> {
  return {
    ...desktopBootstrapFixture(),
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
    }
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

  it('rejects unknown product fields and non-integer calculation values', () => {
    const fixture = desktopBootstrapFixture()
    const product = fixture.products?.[0]

    expect(product).toBeDefined()
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...fixture,
        products: [{ ...product, internal_price_id: 42 }]
      }).success
    ).toBe(false)
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...fixture,
        products: [
          {
            ...product,
            resolved_tax: { ...product?.resolved_tax, rate_basis_points: 1500.5 }
          }
        ]
      }).success
    ).toBe(false)
  })
})

describe('desktopShiftResourceSchema', () => {
  it('accepts the golden cancelled show response with signed expected cash', () => {
    const fixture = desktopShiftFixture({
      status: 'cancelled',
      expected_cash_amount: -250,
      cash_difference_amount: 1250,
      cash_movement_net_amount: -500
    })

    expect(desktopShiftResourceSchema.parse(fixture)).toEqual(fixture)
  })

  it('keeps the strict shift resource contract', () => {
    expect(
      desktopShiftResourceSchema.safeParse({
        ...desktopShiftFixture(),
        unrecognized_shift_field: true
      }).success
    ).toBe(false)
  })
})
