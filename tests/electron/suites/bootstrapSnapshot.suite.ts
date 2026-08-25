import { equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import {
  danglingBarcodeCatalogueFixture,
  desktopBootstrapFixture
} from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

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
        products: [],
        product_barcodes: [],
        product_prices: [],
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
        repository.persistSnapshot(danglingBarcodeCatalogueFixture(), '2026-01-02T00:01:00+00:00'),
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
