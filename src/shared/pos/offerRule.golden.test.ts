import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bestOffer, type OfferCandidate } from './offerRule'

interface GoldenCase {
  readonly name: string
  readonly input: {
    readonly quantity: string
    readonly unitPriceAmount: number
    readonly offers: readonly OfferCandidate[]
  }
  readonly expected: {
    readonly revisionUuid: string
    readonly discountType: 'fixed' | 'percentage'
    readonly discountValue: number
    readonly amount: number
  } | null
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/pos-offer-golden.json', import.meta.url), 'utf8')
) as {
  readonly schemaVersion: number
  readonly ruleVersion: string
  readonly cases: readonly GoldenCase[]
}

describe('offer rule golden (shared with the backend)', () => {
  it('is the backend rule version this register implements', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.ruleVersion).toBe('e1-offer-v1')
    expect(fixture.cases.length).toBeGreaterThan(5)
  })

  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      expect(
        bestOffer(testCase.input.offers, testCase.input.quantity, testCase.input.unitPriceAmount)
      ).toEqual(testCase.expected)
    }
  )
})
