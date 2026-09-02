import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { desktopBootstrapFixture } from '../testing/fixtures/desktopBootstrap.fixture'
import { desktopShiftFixture } from '../testing/fixtures/desktopShift.fixture'
import {
  desktopBootstrapResourceSchema,
  desktopShiftResourceSchema,
  desktopStockAllocationTopUpDataSchema,
  desktopStockAllocationTopUpMetaSchema,
  stockAllocationResourceSchema
} from './desktopResources.contract'

interface AllocationEnvelopeArtifact {
  readonly schemaVersion: number
  readonly allocationContractVersion: number
  readonly resourceKeys: readonly string[]
  readonly fieldContract: Readonly<
    Record<string, { readonly jsonType: string; readonly nullable: boolean }>
  >
  readonly statuses: readonly string[]
  readonly cases: readonly { readonly status: string; readonly resource: unknown }[]
  readonly topUpFragment: { readonly data: unknown; readonly meta: unknown }
  readonly bootstrapFragment: {
    readonly stock_allocations: unknown
    readonly stock_allocation_revision: unknown
  }
  readonly canonicalSha256: string
}

const allocationArtifactRaw = readFileSync(
  new URL('../../../tests/fixtures/stock-allocation-envelope-golden.json', import.meta.url),
  'utf8'
)
const allocationArtifact = JSON.parse(allocationArtifactRaw) as AllocationEnvelopeArtifact

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

function semanticJsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value !== null && typeof value === 'object') return 'object'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

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

describe('desktopBootstrapResourceSchema stock allocations', () => {
  const allocation = {
    id: '11111111-1111-4111-8111-111111111111',
    contract_version: 1,
    company_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    device_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    warehouse_uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    product_uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    server_sequence: 1001,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 7000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 7000,
    consume_until: '2026-01-02T00:00:00+00:00',
    status: 'active',
    envelope_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null
  }

  it('accepts the allocation envelopes and revision the bootstrap payload now carries', () => {
    const result = desktopBootstrapResourceSchema.safeParse({
      ...desktopBootstrapFixture(),
      stock_allocations: [allocation],
      stock_allocation_revision: 42
    })

    expect(result.success).toBe(true)
    expect(result.data?.stock_allocations?.[0]?.remaining_quantity_milli).toBe(7000)
    expect(result.data?.stock_allocation_revision).toBe(42)
  })

  it('accepts a backend that predates the allocation contract', () => {
    const fixture = desktopBootstrapFixture()
    const { stock_allocations, stock_allocation_revision, ...withoutAllocations } = fixture

    expect(stock_allocations).toBeDefined()
    expect(stock_allocation_revision).toBeDefined()
    expect(desktopBootstrapResourceSchema.safeParse(withoutAllocations).success).toBe(true)
  })

  it('rejects unknown allocation fields and broken envelope hashes', () => {
    const fixture = desktopBootstrapFixture()

    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...fixture,
        stock_allocations: [{ ...allocation, revocation_requested_at: null }]
      }).success
    ).toBe(false)
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...fixture,
        stock_allocations: [{ ...allocation, envelope_hash: 'not-a-sha256' }]
      }).success
    ).toBe(false)
  })

  it.each(['active', 'revocation_pending', 'seal_acknowledged', 'released', 'consumed'] as const)(
    'accepts the Laravel %s allocation status',
    (status) => {
      expect(
        desktopBootstrapResourceSchema.safeParse({
          ...desktopBootstrapFixture(),
          stock_allocations: [{ ...allocation, status }],
          stock_allocation_revision: 42
        }).success
      ).toBe(true)
    }
  )

  it('rejects a partial allocation capability pair', () => {
    const fixture = desktopBootstrapFixture()
    const { stock_allocation_revision, ...withoutRevision } = fixture
    const { stock_allocations, ...withoutAllocations } = fixture

    expect(stock_allocation_revision).toBeDefined()
    expect(stock_allocations).toBeDefined()
    expect(desktopBootstrapResourceSchema.safeParse(withoutRevision).success).toBe(false)
    expect(desktopBootstrapResourceSchema.safeParse(withoutAllocations).success).toBe(false)
  })

  it('accepts the allocation-reserved quantity on stock items', () => {
    const fixture = desktopBootstrapFixture()
    const stockItem = fixture.stock_items?.[0]

    expect(stockItem?.allocation_reserved_quantity).toBe(0)
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...fixture,
        stock_items: [{ ...stockItem, allocation_reserved_quantity: 2.5 }]
      }).success
    ).toBe(true)
  })
})

describe('desktopStockAllocationTopUpDataSchema', () => {
  const allocation = {
    id: '70000000-0000-4000-8000-000000000001',
    contract_version: 1,
    company_uuid: '11111111-1111-4111-8111-111111111111',
    device_uuid: '33333333-3333-4333-8333-333333333333',
    warehouse_uuid: '88888888-8888-4888-8888-888888888888',
    product_uuid: '66666666-6666-4666-8666-666666666666',
    server_sequence: 1001,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 7000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 7000,
    consume_until: '2026-01-03T00:00:00+00:00',
    status: 'active',
    envelope_hash: 'd'.repeat(64),
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null
  }

  it('accepts the exact `StockAllocationResource` collection the top-up controller returns', () => {
    expect(desktopStockAllocationTopUpDataSchema.parse([allocation])).toEqual([allocation])
  })

  it('accepts an empty grant set, which the backend returns when nothing was unreserved', () => {
    // `StockAllocationService::topUp()` skips a product whose grantable quantity is zero, so an
    // empty array is a valid success body — coverage revalidation is what fails the sale.
    expect(desktopStockAllocationTopUpDataSchema.parse([])).toEqual([])
  })

  it('rejects an added server field rather than silently discarding it', () => {
    expect(
      desktopStockAllocationTopUpDataSchema.safeParse([{ ...allocation, reserved_until: 'x' }])
        .success
    ).toBe(false)
  })

  it('rejects a lifecycle status this build does not understand', () => {
    expect(
      desktopStockAllocationTopUpDataSchema.safeParse([{ ...allocation, status: 'quarantined' }])
        .success
    ).toBe(false)
  })

  it('rejects a non-integer or non-positive granted quantity', () => {
    expect(
      desktopStockAllocationTopUpDataSchema.safeParse([
        { ...allocation, granted_quantity_milli: 7000.5 }
      ]).success
    ).toBe(false)
    expect(
      desktopStockAllocationTopUpDataSchema.safeParse([
        { ...allocation, granted_quantity_milli: 0 }
      ]).success
    ).toBe(false)
  })

  it('requires the monotonic allocation revision the controller merges into meta', () => {
    expect(
      desktopStockAllocationTopUpMetaSchema.parse({ allocation_revision: 12, trace_id: 'abc' })
    ).toEqual({ allocation_revision: 12 })
    expect(desktopStockAllocationTopUpMetaSchema.safeParse({ trace_id: 'abc' }).success).toBe(false)
    expect(
      desktopStockAllocationTopUpMetaSchema.safeParse({ allocation_revision: '12' }).success
    ).toBe(false)
  })
})

describe('Laravel-derived stock allocation envelope artifact', () => {
  it('pins the approved raw and independently recomputed canonical hashes', () => {
    const hashable = Object.fromEntries(
      Object.entries(allocationArtifact).filter(([key]) => key !== 'canonicalSha256')
    )
    const canonicalSha256 = createHash('sha256')
      .update(JSON.stringify(canonicalize(hashable)))
      .digest('hex')

    expect(createHash('sha256').update(allocationArtifactRaw).digest('hex')).toBe(
      'ee71f33fa919983626fae769b831184b1bb47d44eb2de108a9bef995407fa049'
    )
    expect(canonicalSha256).toBe('bdd091b018a08155b81f258167d56a926bd4520a88097a7c6f09c8b8ae9ae83b')
    expect(canonicalSha256).toBe(allocationArtifact.canonicalSha256)
  })

  it('drives every Laravel status through the one strict allocation resource schema', () => {
    expect(allocationArtifact.schemaVersion).toBe(1)
    expect(allocationArtifact.allocationContractVersion).toBe(1)
    expect(allocationArtifact.statuses).toStrictEqual([
      'active',
      'revocation_pending',
      'seal_acknowledged',
      'released',
      'consumed'
    ])
    expect(allocationArtifact.cases.map(({ status }) => status)).toStrictEqual(
      allocationArtifact.statuses
    )

    for (const fixtureCase of allocationArtifact.cases) {
      const parsed = stockAllocationResourceSchema.parse(fixtureCase.resource)
      expect(parsed.status).toBe(fixtureCase.status)
      expect(Object.keys(parsed)).toStrictEqual(allocationArtifact.resourceKeys)

      const resource = fixtureCase.resource as Record<string, unknown>
      for (const key of allocationArtifact.resourceKeys) {
        const contract = allocationArtifact.fieldContract[key]
        expect(contract).toBeDefined()
        if (resource[key] === null) {
          expect(contract?.nullable).toBe(true)
        } else {
          expect(semanticJsonType(resource[key])).toBe(contract?.jsonType)
        }
      }
    }
  })

  it('parses the Laravel fragments through the actual bootstrap and top-up schemas', () => {
    const bootstrap = desktopBootstrapResourceSchema.parse({
      ...desktopBootstrapFixture(),
      ...allocationArtifact.bootstrapFragment
    })
    const topUp = desktopStockAllocationTopUpDataSchema.parse(allocationArtifact.topUpFragment.data)
    const topUpMeta = desktopStockAllocationTopUpMetaSchema.parse(
      allocationArtifact.topUpFragment.meta
    )

    expect(bootstrap.stock_allocations).toStrictEqual(topUp)
    expect(bootstrap.stock_allocation_revision).toBe(topUpMeta.allocation_revision)
  })

  it('makes unknown-key and revision-type drift fail both real consumer paths closed', () => {
    const [first] = allocationArtifact.cases
    const drifted = { ...(first?.resource as Record<string, unknown>), future_field: true }

    expect(stockAllocationResourceSchema.safeParse(drifted).success).toBe(false)
    expect(desktopStockAllocationTopUpDataSchema.safeParse([drifted]).success).toBe(false)
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...desktopBootstrapFixture(),
        stock_allocations: [drifted],
        stock_allocation_revision: 500
      }).success
    ).toBe(false)
    expect(
      desktopBootstrapResourceSchema.safeParse({
        ...desktopBootstrapFixture(),
        stock_allocations: allocationArtifact.bootstrapFragment.stock_allocations,
        stock_allocation_revision: '500'
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
