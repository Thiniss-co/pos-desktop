import { describe, expect, it } from 'vitest'
import { applyOffers, type CatalogOffer, type OfferPricingLine } from './offerRule'

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'

function offer(overrides: Partial<CatalogOffer> = {}): CatalogOffer {
  return {
    revisionUuid: '10000000-0000-4000-8000-000000000001',
    name: 'Ten off',
    type: 'percentage',
    value: 1000,
    priority: 0,
    ordinal: 1,
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-10-10T00:00:00.000Z',
    productUuids: [P1],
    ...overrides
  }
}

const line = (overrides: Partial<OfferPricingLine> = {}): OfferPricingLine => ({
  id: 'l1',
  productUuid: P1,
  quantity: '2.000',
  unitPriceAmount: 1000,
  discountType: null,
  discountValue: 0,
  ...overrides
})

describe('applyOffers', () => {
  it('applies the targeted offer inside its window', () => {
    const applied = applyOffers([line()], [offer()], new Date('2026-10-05T00:00:00Z'))
    expect(applied.get('l1')).toEqual({
      revisionUuid: '10000000-0000-4000-8000-000000000001',
      discountType: 'percentage',
      discountValue: 1000,
      amount: 200,
      name: 'Ten off'
    })
  })

  it('treats the start as inclusive and the end as exclusive', () => {
    expect(applyOffers([line()], [offer()], new Date('2026-10-01T00:00:00Z')).size).toBe(1)
    expect(applyOffers([line()], [offer()], new Date('2026-10-10T00:00:00Z')).size).toBe(0)
    expect(
      applyOffers([line()], [offer({ endsAt: null })], new Date('2030-01-01T00:00:00Z')).size
    ).toBe(1)
  })

  it('never offers a line with a manual discount or an untargeted product', () => {
    const at = new Date('2026-10-05T00:00:00Z')
    expect(
      applyOffers([line({ discountType: 'fixed', discountValue: 5 })], [offer()], at).size
    ).toBe(0)
    expect(applyOffers([line({ productUuid: P2 })], [offer()], at).size).toBe(0)
  })

  it('picks the higher priority before the larger amount', () => {
    const applied = applyOffers(
      [line()],
      [
        offer(),
        offer({
          revisionUuid: '10000000-0000-4000-8000-000000000002',
          name: 'Small but first',
          type: 'amount_off',
          value: 10,
          priority: 5,
          ordinal: 2
        })
      ],
      new Date('2026-10-05T00:00:00Z')
    )
    expect(applied.get('l1')?.name).toBe('Small but first')
    expect(applied.get('l1')?.amount).toBe(20)
  })

  it('returns nothing without offers', () => {
    expect(applyOffers([line()], undefined, new Date()).size).toBe(0)
  })
})
