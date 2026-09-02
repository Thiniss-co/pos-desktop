import { describe, expect, it } from 'vitest'
import {
  buildTopUpRequest,
  calculateAllocationDeficits,
  TOP_UP_MAX_ITEMS,
  TOP_UP_MAX_QUANTITY_MILLI
} from './allocationDeficit'

const chips = '11111111-1111-4111-8111-111111111111'
const cola = '22222222-2222-4222-8222-222222222222'
const water = '33333333-3333-4333-8333-333333333333'

const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('calculateAllocationDeficits', () => {
  it('requests exactly the required quantity when no grant is held', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [{ lineId: 'line-1', productUuid: cola, requiredMilli: 1000 }],
      usableMilliByProduct: new Map()
    })

    expect(result).toEqual({
      kind: 'deficit',
      items: [{ productUuid: cola, requiredMilli: 1000, usableMilli: 0, deficitMilli: 1000 }],
      affectedLineIds: ['line-1']
    })
  })

  it('reports full coverage rather than requesting a buffer', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [{ lineId: 'line-1', productUuid: cola, requiredMilli: 1000 }],
      // Holding more than the cart needs must never produce a request at all.
      usableMilliByProduct: new Map([[cola, 5000]])
    })

    expect(result).toEqual({ kind: 'covered' })
  })

  it('requests only the exact positive deficit under partial coverage', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [{ lineId: 'line-1', productUuid: cola, requiredMilli: 3000 }],
      usableMilliByProduct: new Map([[cola, 1250]])
    })

    expect(result).toMatchObject({
      kind: 'deficit',
      items: [{ deficitMilli: 1750 }]
    })
  })

  it('aggregates duplicate lines of one product instead of under-requesting per line', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [
        { lineId: 'line-1', productUuid: cola, requiredMilli: 1000 },
        { lineId: 'line-2', productUuid: cola, requiredMilli: 2000 },
        { lineId: 'line-3', productUuid: cola, requiredMilli: 500 }
      ],
      usableMilliByProduct: new Map([[cola, 500]])
    })

    expect(result).toMatchObject({
      kind: 'deficit',
      items: [{ productUuid: cola, requiredMilli: 3500, deficitMilli: 3000 }],
      affectedLineIds: ['line-1', 'line-2', 'line-3']
    })
  })

  it('orders multiple products deterministically regardless of cart order', () => {
    const lines = [
      { lineId: 'line-1', productUuid: water, requiredMilli: 1000 },
      { lineId: 'line-2', productUuid: chips, requiredMilli: 1000 },
      { lineId: 'line-3', productUuid: cola, requiredMilli: 1000 }
    ]
    const forward = calculateAllocationDeficits({
      trackedLines: lines,
      usableMilliByProduct: new Map()
    })
    const reversed = calculateAllocationDeficits({
      trackedLines: [...lines].reverse(),
      usableMilliByProduct: new Map()
    })

    expect(forward).toMatchObject({ kind: 'deficit' })
    if (forward.kind === 'deficit' && reversed.kind === 'deficit') {
      expect(forward.items.map((item) => item.productUuid)).toEqual([chips, cola, water])
      expect(reversed.items).toEqual(forward.items)
    }
  })

  it('omits products that are already covered while keeping the ones that are not', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [
        { lineId: 'line-1', productUuid: chips, requiredMilli: 1000 },
        { lineId: 'line-2', productUuid: cola, requiredMilli: 1000 }
      ],
      // Chips is covered exactly; cola is over-covered; neither may be requested.
      usableMilliByProduct: new Map([
        [chips, 1000],
        [cola, 4000]
      ])
    })

    expect(result).toEqual({ kind: 'covered' })
  })

  it('is case-insensitive about product identity so a cart cannot split one product in two', () => {
    const result = calculateAllocationDeficits({
      trackedLines: [
        { lineId: 'line-1', productUuid: cola, requiredMilli: 1000 },
        { lineId: 'line-2', productUuid: cola.toUpperCase(), requiredMilli: 1000 }
      ],
      usableMilliByProduct: new Map([[cola, 500]])
    })

    expect(result).toMatchObject({ kind: 'deficit', items: [{ deficitMilli: 1500 }] })
  })

  it('fails closed rather than splitting a demand beyond the backend collection bound', () => {
    const trackedLines = Array.from({ length: TOP_UP_MAX_ITEMS + 1 }, (_value, index) => ({
      lineId: `line-${index}`,
      productUuid: `${index.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
      requiredMilli: 1000
    }))

    expect(
      calculateAllocationDeficits({ trackedLines, usableMilliByProduct: new Map() })
    ).toMatchObject({ kind: 'unrepresentable' })
  })

  it('fails closed rather than truncating a demand beyond the backend quantity bound', () => {
    expect(
      calculateAllocationDeficits({
        trackedLines: [
          { lineId: 'line-1', productUuid: cola, requiredMilli: TOP_UP_MAX_QUANTITY_MILLI + 1 }
        ],
        usableMilliByProduct: new Map()
      })
    ).toMatchObject({ kind: 'unrepresentable' })
  })
})

describe('buildTopUpRequest', () => {
  const items = [
    { productUuid: chips, requiredMilli: 1500, usableMilli: 0, deficitMilli: 1500 },
    { productUuid: cola, requiredMilli: 2000, usableMilli: 500, deficitMilli: 1500 }
  ]

  it('sends canonical three-decimal quantities the backend parses to the intended thousandths', () => {
    expect(buildTopUpRequest(ATTEMPT_KEY, items).items).toEqual([
      { product_uuid: chips, quantity: '1.500' },
      { product_uuid: cola, quantity: '1.500' }
    ])
  })

  it('derives a replay-stable idempotency key from the attempt and the exact demand', () => {
    const first = buildTopUpRequest(ATTEMPT_KEY, items)
    const second = buildTopUpRequest(
      ATTEMPT_KEY,
      items.map((item) => ({ ...item }))
    )

    expect(first.idempotency_key).toBe(second.idempotency_key)
    expect(first.idempotency_key).toMatch(/^[a-f0-9]{64}$/)
    // Laravel caps `idempotency_key` at 255 characters.
    expect(first.idempotency_key.length).toBeLessThanOrEqual(255)
  })

  it('changes the key when the demand changes, so a smaller retry is not a false conflict', () => {
    // Laravel binds a stored key to its request hash and answers changed content with
    // 409 IDEMPOTENCY_CONFLICT. A partially granted top-up legitimately shrinks the next retry's
    // deficit, so that retry must be a different request rather than a permanent conflict.
    const smaller = buildTopUpRequest(ATTEMPT_KEY, [{ ...items[0], deficitMilli: 500 }])

    expect(smaller.idempotency_key).not.toBe(buildTopUpRequest(ATTEMPT_KEY, items).idempotency_key)
  })

  it('binds the key to the sale attempt, so two attempts never share a grant request', () => {
    expect(
      buildTopUpRequest('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', items).idempotency_key
    ).not.toBe(buildTopUpRequest(ATTEMPT_KEY, items).idempotency_key)
  })
})
