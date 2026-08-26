import { deepEqual, equal } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

const allowedAccess = {
  evaluate: () => ({ allowed: true }),
  assertAllowed: () => undefined
}

function clock(value: string): { now: () => { now: Date; rollbackDetected: boolean } } {
  return {
    now: () => ({ now: new Date(value), rollbackDetected: false })
  }
}

databaseTest(
  'the local catalog survives reopen and supports bounded deterministic reads',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const fixture = desktopBootstrapFixture()
    const original = fixture.products?.[0]

    if (!original) {
      throw new Error('Catalog fixture must contain one product')
    }

    realRepositories(database).bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        products: [
          original,
          {
            ...original,
            uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            name: 'Hidden Product',
            status: 'inactive',
            is_active: false
          }
        ]
      }),
      '2026-01-01T00:01:00+00:00'
    )
    closeDatabase(database)

    const reopened = openExistingTestDatabase(sandbox)
    const repository = realRepositories(reopened).catalog
    const contract = repository.getContract()
    equal(contract?.revision, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    deepEqual(repository.listCategories(), [
      { uuid: '44444444-4444-4444-8444-444444444444', name: 'Beverages' }
    ])

    const byName = repository.searchProducts({
      query: 'sparkling',
      categoryUuid: null,
      limit: 24,
      offset: 0
    })
    equal(byName.total, 1)
    equal(byName.items[0]?.price.amount, 1250)
    equal(byName.items[0]?.tax.rateBasisPoints, 1500)
    equal(
      repository.searchProducts({
        query: '',
        categoryUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        limit: 24,
        offset: 0
      }).total,
      0
    )
    equal(
      repository.searchProducts({ query: 'hidden', categoryUuid: null, limit: 24, offset: 0 })
        .total,
      0
    )
    equal(
      repository.searchProducts({ query: '%', categoryUuid: null, limit: 24, offset: 0 }).total,
      0,
      'LIKE wildcard input must be escaped'
    )
    equal(repository.findProductsByBarcode('1234567890123').length, 1)
    closeDatabase(reopened)
  }
)

databaseTest(
  'catalog validity excludes exact end equality and ambiguous barcodes fail closed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const fixture = desktopBootstrapFixture()
    const original = fixture.products?.[0]

    if (!original) {
      throw new Error('Catalog fixture must contain one product')
    }

    realRepositories(database).bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture({
        products: [
          original,
          {
            ...original,
            uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            name: 'Still Water',
            sku: 'WATER-002',
            barcode: '9999999999999'
          }
        ],
        product_barcodes: [
          ...(fixture.product_barcodes ?? []),
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            product_uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            barcode: '1234567890123',
            type: 'ean13',
            is_primary: false,
            is_active: true,
            updated_at: '2026-01-01T00:00:00+00:00'
          }
        ]
      }),
      '2026-01-01T00:01:00+00:00'
    )
    const repository = realRepositories(database).catalog
    const atStart = new CatalogService(
      repository,
      allowedAccess,
      clock('2026-01-01T00:00:00+00:00')
    )
    equal(atStart.getStatus().status, 'cached')
    equal(atStart.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).total, 2)
    const atExpiry = new CatalogService(
      repository,
      allowedAccess,
      clock('2026-01-04T00:00:00+00:00')
    )
    equal(atExpiry.getStatus().status, 'stale')
    equal(atExpiry.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).total, 2)

    const valid = new CatalogService(repository, allowedAccess, clock('2026-01-02T00:00:00+00:00'))
    const firstPage = valid.searchProducts({ query: '', categoryUuid: null, limit: 1, offset: 0 })
    const secondPage = valid.searchProducts({ query: '', categoryUuid: null, limit: 1, offset: 1 })
    equal(firstPage.total, 2)
    equal(firstPage.items[0]?.name, 'Sparkling Water')
    equal(secondPage.items[0]?.name, 'Still Water')
    equal(valid.findProductByBarcode('1234567890123').outcome, 'ambiguous')
    closeDatabase(database)
  }
)
