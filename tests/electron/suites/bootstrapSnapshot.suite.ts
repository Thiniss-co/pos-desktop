import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type {
  DesktopBootstrapResource,
  StockAllocationResource
} from '../../../src/main/http/desktopResources.contract'
import {
  danglingBarcodeCatalogueFixture,
  desktopBootstrapFixture
} from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

function allocationEnvelope(
  overrides: Partial<StockAllocationResource> = {}
): StockAllocationResource {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    contract_version: 1,
    company_uuid: '11111111-1111-4111-8111-111111111111',
    device_uuid: '33333333-3333-4333-8333-333333333333',
    warehouse_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    product_uuid: '55555555-5555-4555-8555-555555555555',
    server_sequence: 1,
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
    released_at: null,
    ...overrides
  }
}

function unsupportedAllocationBootstrap(): DesktopBootstrapResource {
  const resource = desktopBootstrapFixture()
  delete resource.stock_allocations
  delete resource.stock_allocation_revision
  return resource
}

databaseTest(
  'bootstrap snapshots persist atomically, survive reopen, and expose persisted company metadata',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).bootstrapSnapshot
    const result = repository.persistSnapshot(
      desktopBootstrapFixture(),
      '2026-01-01T00:01:00+00:00'
    )

    equal(result.counts.products, 1)
    equal(repository.getCompany()?.name, 'Example Shop')
    equal(repository.isFeatureEnabled('pos'), true)
    equal(repository.isFeatureEnabled('unknown'), false)
    equal(
      repository.persistSnapshot(
        desktopBootstrapFixture({
          device: { ...desktopBootstrapFixture().device, status: 'blocked_selling' }
        }),
        '2026-01-01T00:02:00+00:00'
      ).counts.products,
      1
    )
    equal(
      readCommitted<{ status: string }>(sandbox, 'SELECT status FROM device_registration')[0]
        ?.status,
      'blocked_selling'
    )
    closeDatabase(database)

    equal(
      readCommitted<{ name: string }>(sandbox, 'SELECT name FROM bootstrap_company')[0]?.name,
      'Example Shop'
    )
    equal(readCommitted(sandbox, 'SELECT * FROM catalog_products').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM catalog_metadata').length, 1)
  }
)

databaseTest(
  'a second bootstrap replaces a non-empty catalogue with foreign keys enabled',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).bootstrapSnapshot
    repository.persistSnapshot(desktopBootstrapFixture(), '2026-01-01T00:01:00+00:00')
    repository.persistSnapshot(
      desktopBootstrapFixture({
        catalog_contract: {
          ...desktopBootstrapFixture().catalog_contract,
          revision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          generated_at: '2026-01-02T00:00:00+00:00',
          valid_until: '2026-01-05T00:00:00+00:00'
        },
        products: [],
        product_barcodes: [],
        stock_items: []
      }),
      '2026-01-02T00:01:00+00:00'
    )
    closeDatabase(database)

    equal(readCommitted(sandbox, 'SELECT * FROM catalog_products').length, 0)
    equal(readCommitted(sandbox, 'SELECT * FROM catalog_product_barcodes').length, 0)
  }
)

databaseTest(
  'bootstrap snapshot write failures roll back to the exact committed bytes',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const stableRepository = realRepositories(database).bootstrapSnapshot
    stableRepository.persistSnapshot(desktopBootstrapFixture(), '2026-01-01T00:01:00+00:00')
    const before = tableDigest(sandbox, 'catalog_products')
    let observedWrites = 0
    const failingRepository = realRepositories(
      failingDatabase(database, {
        failOnWriteNumber: 5,
        onWrite: (count) => (observedWrites = count)
      })
    ).bootstrapSnapshot

    throws(
      () =>
        failingRepository.persistSnapshot(
          desktopBootstrapFixture({ features: { pos: false } }),
          '2026-01-02T00:01:00+00:00'
        ),
      /Injected SQLite write failure/
    )
    equal(observedWrites, 5)
    closeDatabase(database)

    equal(tableDigest(sandbox, 'catalog_products'), before)
    equal(
      readCommitted<{ is_enabled: number }>(
        sandbox,
        'SELECT is_enabled FROM bootstrap_features WHERE feature_code = ?',
        ['pos']
      )[0]?.is_enabled,
      1
    )
  }
)

databaseTest(
  'a dangling bootstrap barcode is rejected by SQLite and preserves the previous snapshot',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repository = realRepositories(database).bootstrapSnapshot
    repository.persistSnapshot(desktopBootstrapFixture(), '2026-01-01T00:01:00+00:00')
    const before = tableDigest(sandbox, 'catalog_products')

    throws(
      () =>
        repository.persistSnapshot(
          desktopBootstrapFixture({
            catalog_contract: {
              ...desktopBootstrapFixture().catalog_contract,
              revision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              generated_at: '2026-01-02T00:00:00+00:00',
              valid_until: '2026-01-05T00:00:00+00:00'
            },
            products: [],
            product_barcodes: danglingBarcodeCatalogueFixture().product_barcodes
          }),
          '2026-01-02T00:01:00+00:00'
        ),
      /FOREIGN KEY constraint failed/
    )
    closeDatabase(database)

    equal(tableDigest(sandbox, 'catalog_products'), before)
  }
)

databaseTest('an invalid catalog contract preserves the complete prior snapshot', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repository = realRepositories(database).bootstrapSnapshot
  const fixture = desktopBootstrapFixture()
  repository.persistSnapshot(fixture, '2026-01-01T00:01:00+00:00')
  const beforeProducts = tableDigest(sandbox, 'catalog_products')
  const beforeMetadata = tableDigest(sandbox, 'catalog_metadata')
  const product = fixture.products?.[0]

  throws(() =>
    repository.persistSnapshot(
      desktopBootstrapFixture({
        products: product
          ? [
              {
                ...product,
                resolved_price: product.resolved_price
                  ? { ...product.resolved_price, valid_until: '2026-01-03T00:00:00+00:00' }
                  : null
              }
            ]
          : []
      }),
      '2026-01-02T00:01:00+00:00'
    )
  )
  closeDatabase(database)

  equal(tableDigest(sandbox, 'catalog_products'), beforeProducts)
  equal(tableDigest(sandbox, 'catalog_metadata'), beforeMetadata)
})

databaseTest(
  'bootstrap allocation envelopes preserve Laravel statuses and survive a database reopen',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const statuses = [
      'active',
      'revocation_pending',
      'seal_acknowledged',
      'released',
      'consumed'
    ] as const
    const allocations = statuses.map((status, index) =>
      allocationEnvelope({
        id: `70000000-0000-4000-8000-00000000000${index + 1}`,
        server_sequence: index + 1,
        status,
        consumed_quantity_milli: status === 'consumed' ? 7000 : 0,
        remaining_quantity_milli: status === 'consumed' ? 0 : 7000
      })
    )

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ stock_allocations: allocations, stock_allocation_revision: 7 }),
      '2026-01-01T00:01:00+00:00'
    )

    deepEqual(
      allocations.map(
        (allocation) => repositories.stockAllocations.findGrantByUuid(allocation.id)?.status
      ),
      statuses
    )
    equal(repositories.stockAllocations.getCapability()?.revision, 7)
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        {
          companyUuid: allocations[0].company_uuid,
          deviceUuid: allocations[0].device_uuid,
          warehouseUuid: allocations[0].warehouse_uuid
        },
        allocations[0].product_uuid,
        '2026-01-01T00:01:00+00:00'
      ).length,
      1
    )
    closeDatabase(database)

    const reopened = openTestDatabase(sandbox)
    const reopenedRepositories = realRepositories(reopened)
    deepEqual(
      allocations.map(
        (allocation) => reopenedRepositories.stockAllocations.findGrantByUuid(allocation.id)?.status
      ),
      statuses
    )
    equal(reopenedRepositories.stockAllocations.getCapability()?.revision, 7)
    closeDatabase(reopened)
  }
)

databaseTest(
  'allocation resolution requires the exact current owner, product, active status, and revision',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const active = allocationEnvelope()
    const inactive = allocationEnvelope({
      id: '70000000-0000-4000-8000-000000000002',
      server_sequence: 2,
      status: 'revocation_pending'
    })
    const owner = {
      companyUuid: active.company_uuid,
      deviceUuid: active.device_uuid,
      warehouseUuid: active.warehouse_uuid
    }

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        stock_allocations: [active, inactive],
        stock_allocation_revision: 7
      }),
      '2026-01-01T00:01:00+00:00'
    )

    deepEqual(
      repositories.stockAllocations
        .usableGrantsForProduct(owner, active.product_uuid, '2026-01-01T00:02:00+00:00')
        .map((grant) => grant.allocationUuid),
      [active.id]
    )
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        { ...owner, companyUuid: '99999999-9999-4999-8999-999999999999' },
        active.product_uuid,
        '2026-01-01T00:02:00+00:00'
      ).length,
      0
    )
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        { ...owner, deviceUuid: '99999999-9999-4999-8999-999999999999' },
        active.product_uuid,
        '2026-01-01T00:02:00+00:00'
      ).length,
      0
    )
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        { ...owner, warehouseUuid: '99999999-9999-4999-8999-999999999999' },
        active.product_uuid,
        '2026-01-01T00:02:00+00:00'
      ).length,
      0
    )
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        owner,
        '99999999-9999-4999-8999-999999999999',
        '2026-01-01T00:02:00+00:00'
      ).length,
      0
    )

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ stock_allocations: [], stock_allocation_revision: 8 }),
      '2026-01-01T00:03:00+00:00'
    )
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        owner,
        active.product_uuid,
        '2026-01-01T00:04:00+00:00'
      ).length,
      0
    )

    closeDatabase(database)
  }
)

databaseTest(
  'a newer full allocation snapshot retains omitted evidence but makes it unusable',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const allocation = allocationEnvelope()
    const owner = {
      companyUuid: allocation.company_uuid,
      deviceUuid: allocation.device_uuid,
      warehouseUuid: allocation.warehouse_uuid
    }

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ stock_allocations: [allocation], stock_allocation_revision: 7 }),
      '2026-01-01T00:01:00+00:00'
    )
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ stock_allocations: [], stock_allocation_revision: 8 }),
      '2026-01-01T00:02:00+00:00'
    )

    equal(repositories.stockAllocations.findGrantByUuid(allocation.id)?.lastObservedRevision, 7)
    equal(repositories.stockAllocations.getCapability()?.revision, 8)
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        owner,
        allocation.product_uuid,
        '2026-01-01T00:02:00+00:00'
      ).length,
      0
    )
    throws(
      () =>
        repositories.bootstrapSnapshot.persistSnapshot(
          desktopBootstrapFixture({
            stock_allocations: [allocation],
            stock_allocation_revision: 7
          }),
          '2026-01-01T00:03:00+00:00'
        ),
      /older than the active local allocation snapshot/
    )

    repositories.bootstrapSnapshot.persistSnapshot(
      unsupportedAllocationBootstrap(),
      '2026-01-01T00:04:00+00:00'
    )
    equal(repositories.stockAllocations.getCapability()?.state, 'unavailable')
    equal(repositories.stockAllocations.findGrantByUuid(allocation.id)?.status, 'active')
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        owner,
        allocation.product_uuid,
        '2026-01-01T00:04:00+00:00'
      ).length,
      0
    )
    closeDatabase(database)
  }
)

databaseTest(
  'allocation snapshot revisions, lifecycle, identity, quantities, and status transitions fail closed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const initial = allocationEnvelope({ lifecycle_generation: 2 })
    const revisionSeven = desktopBootstrapFixture({
      stock_allocations: [initial],
      stock_allocation_revision: 7
    })

    repositories.bootstrapSnapshot.persistSnapshot(revisionSeven, '2026-01-01T00:01:00+00:00')
    const initialDigest = tableDigest(sandbox, 'stock_allocation_grants')

    // Equal-revision replay is exactly idempotent.
    repositories.bootstrapSnapshot.persistSnapshot(revisionSeven, '2026-01-01T00:02:00+00:00')
    equal(tableDigest(sandbox, 'stock_allocation_grants'), initialDigest)

    // A higher revision with the same immutable identity advances observation authority.
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({ stock_allocations: [initial], stock_allocation_revision: 8 }),
      '2026-01-01T00:03:00+00:00'
    )
    equal(repositories.stockAllocations.getCapability()?.revision, 8)
    equal(repositories.stockAllocations.findGrantByUuid(initial.id)?.lastObservedRevision, 8)
    const stableDigest = tableDigest(sandbox, 'stock_allocation_grants')

    throws(() =>
      repositories.bootstrapSnapshot.persistSnapshot(
        desktopBootstrapFixture({
          stock_allocations: [allocationEnvelope({ lifecycle_generation: 1 })],
          stock_allocation_revision: 9
        }),
        '2026-01-01T00:04:00+00:00'
      )
    )
    throws(() =>
      repositories.bootstrapSnapshot.persistSnapshot(
        desktopBootstrapFixture({
          stock_allocations: [
            allocationEnvelope({ device_uuid: '99999999-9999-4999-8999-999999999999' })
          ],
          stock_allocation_revision: 9
        }),
        '2026-01-01T00:04:00+00:00'
      )
    )
    throws(() =>
      repositories.bootstrapSnapshot.persistSnapshot(
        desktopBootstrapFixture({
          stock_allocations: [
            allocationEnvelope({ warehouse_uuid: '99999999-9999-4999-8999-999999999999' })
          ],
          stock_allocation_revision: 9
        }),
        '2026-01-01T00:04:00+00:00'
      )
    )
    throws(() =>
      repositories.bootstrapSnapshot.persistSnapshot(
        desktopBootstrapFixture({
          stock_allocations: [allocationEnvelope({ remaining_quantity_milli: 6999 })],
          stock_allocation_revision: 9
        }),
        '2026-01-01T00:04:00+00:00'
      )
    )
    equal(repositories.stockAllocations.getCapability()?.revision, 8)
    equal(tableDigest(sandbox, 'stock_allocation_grants'), stableDigest)

    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        stock_allocations: [
          allocationEnvelope({
            lifecycle_generation: 2,
            consumed_quantity_milli: 7000,
            remaining_quantity_milli: 0,
            status: 'consumed'
          })
        ],
        stock_allocation_revision: 9
      }),
      '2026-01-01T00:05:00+00:00'
    )
    equal(repositories.stockAllocations.findGrantByUuid(initial.id)?.status, 'consumed')
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        {
          companyUuid: initial.company_uuid,
          deviceUuid: initial.device_uuid,
          warehouseUuid: initial.warehouse_uuid
        },
        initial.product_uuid,
        '2026-01-01T00:06:00+00:00'
      ).length,
      0
    )
    closeDatabase(database)
  }
)

databaseTest('a failed allocation write rolls back the entire bootstrap snapshot', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const stable = realRepositories(database)
  stable.bootstrapSnapshot.persistSnapshot(
    unsupportedAllocationBootstrap(),
    '2026-01-01T00:01:00+00:00'
  )
  const beforeCatalog = tableDigest(sandbox, 'catalog_metadata')
  const failing = realRepositories(
    failingDatabase(database, {
      failWhen: (statementSql) => statementSql.includes('INSERT INTO stock_allocation_grants')
    })
  )

  throws(
    () =>
      failing.bootstrapSnapshot.persistSnapshot(
        desktopBootstrapFixture({
          stock_allocations: [allocationEnvelope()],
          stock_allocation_revision: 7
        }),
        '2026-01-01T00:02:00+00:00'
      ),
    /Injected SQLite write failure/
  )

  equal(tableDigest(sandbox, 'catalog_metadata'), beforeCatalog)
  equal(stable.stockAllocations.getCapability()?.state, 'unavailable')
  equal(stable.stockAllocations.findGrantByUuid(allocationEnvelope().id), null)
  closeDatabase(database)
})
