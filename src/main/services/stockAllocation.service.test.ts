import { describe, expect, it } from 'vitest'
import { splitAllocations, StockAllocationService } from './stockAllocation.service'
import type { StockAllocationGrantRow } from '@shared/contracts/sale.contract'

function grant(overrides: Partial<StockAllocationGrantRow> = {}): StockAllocationGrantRow {
  return {
    allocationUuid: '00000000-0000-4000-8000-000000000001',
    contractVersion: 1,
    companyUuid: '00000000-0000-4000-8000-000000000010',
    deviceUuid: '00000000-0000-4000-8000-000000000011',
    warehouseUuid: '00000000-0000-4000-8000-000000000012',
    productUuid: '00000000-0000-4000-8000-000000000013',
    serverSequence: 1,
    rightsGeneration: 1,
    lifecycleGeneration: 1,
    grantedQuantityMilli: 5000,
    serverConsumedQuantityMilli: 0,
    serverRemainingQuantityMilli: 5000,
    consumeUntil: '2026-12-31T00:00:00.000Z',
    status: 'active',
    envelopeHash: 'a'.repeat(64),
    sealNonce: null,
    finalConsumptionSequence: null,
    finalConsumptionHash: null,
    receivedAt: '2026-08-29T00:00:00.000Z',
    sealedAt: null,
    acknowledgedAt: null,
    releasedAt: null,
    lastObservedRevision: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides
  }
}

let uuidCounter = 0
const createUuid = (): string => `uuid-${++uuidCounter}`

describe('splitAllocations', () => {
  it('covers a single line exactly from one grant', () => {
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 5000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [3000],
      createUuid
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.perLine).toEqual([
        [
          {
            allocationUuid: grantA.allocationUuid,
            rightsGeneration: 1,
            consumptionSequence: 1,
            localConsumptionUuid: expect.any(String),
            quantityMilli: 3000
          }
        ]
      ])
    }
  })

  it('splits one line across two grants in order when the first is insufficient alone', () => {
    const grantA = grant({ allocationUuid: 'alloc-a', consumeUntil: '2026-09-01T00:00:00.000Z' })
    const grantB = grant({ allocationUuid: 'alloc-b', consumeUntil: '2026-10-01T00:00:00.000Z' })
    const result = splitAllocations({
      grants: [grantA, grantB],
      remainingMilliByAllocation: new Map([
        [grantA.allocationUuid, 1000],
        [grantB.allocationUuid, 5000]
      ]),
      nextSequenceByAllocation: new Map([
        [grantA.allocationUuid, 1],
        [grantB.allocationUuid, 1]
      ]),
      lineDemandsMilli: [3000],
      createUuid
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.perLine[0]).toHaveLength(2)
      expect(result.perLine[0][0]).toMatchObject({ allocationUuid: 'alloc-a', quantityMilli: 1000 })
      expect(result.perLine[0][1]).toMatchObject({ allocationUuid: 'alloc-b', quantityMilli: 2000 })
    }
  })

  it('fails closed as stock-allocation-unavailable when combined grants are insufficient', () => {
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 1000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [3000],
      createUuid
    })

    expect(result).toEqual({ ok: false, code: 'stock-allocation-unavailable' })
  })

  it('never allocates the same grant quantity twice across two duplicate-product lines', () => {
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 5000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [3000, 2000],
      createUuid
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.perLine[0]).toEqual([
        expect.objectContaining({ consumptionSequence: 1, quantityMilli: 3000 })
      ])
      expect(result.perLine[1]).toEqual([
        expect.objectContaining({ consumptionSequence: 2, quantityMilli: 2000 })
      ])
    }
  })

  it('rejects the whole plan when the second of two duplicate-product lines cannot be covered', () => {
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 3000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [3000, 1],
      createUuid
    })

    expect(result).toEqual({ ok: false, code: 'stock-allocation-unavailable' })
  })

  it('assigns no entries to a zero-demand (untracked) line', () => {
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 5000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [0],
      createUuid
    })

    expect(result).toEqual({ ok: true, perLine: [[]] })
  })

  it('fails closed when there are no usable grants at all', () => {
    const result = splitAllocations({
      grants: [],
      remainingMilliByAllocation: new Map(),
      nextSequenceByAllocation: new Map(),
      lineDemandsMilli: [1000],
      createUuid
    })

    expect(result).toEqual({ ok: false, code: 'stock-allocation-unavailable' })
  })
})

describe('StockAllocationService', () => {
  it('reports allocation data unavailable when the latest bootstrap lacks the capability', () => {
    const service = new StockAllocationService({
      getCapability: () => ({
        state: 'unavailable' as const,
        revision: null,
        observedAt: '2026-08-29T00:00:00.000Z'
      }),
      usableGrantsForProduct: () => {
        throw new Error('A backend without allocation capability must not query retained grants')
      },
      remainingMilli: () => 0,
      nextConsumptionSequence: () => 1
    })

    expect(
      service.splitForProduct(
        {
          companyUuid: '00000000-0000-4000-8000-000000000010',
          deviceUuid: '00000000-0000-4000-8000-000000000011',
          warehouseUuid: '00000000-0000-4000-8000-000000000012'
        },
        '00000000-0000-4000-8000-000000000013',
        [1000],
        '2026-08-29T00:00:00.000Z'
      )
    ).toEqual({ ok: false, code: 'allocation-data-unavailable' })
  })
})
