import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import type { ProductStockView } from '../../../src/shared/contracts/catalog.contract'
import { StockViewService } from '../../../src/main/services/stockView.service'
import { databaseTest } from '../support/sandbox'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  companyUuid,
  deviceUuid,
  methodUuid,
  productUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent
} from '../support/localSaleFixture'
import {
  allocationEnvelope,
  enableAllocationCapability,
  BOOTSTRAP_ALLOCATION_REVISION
} from '../support/allocationTopUp'

/**
 * POS reliability rev 3 (Area 1) on real SQLite: the separated stock facts. Nothing here is an
 * adjusted warehouse balance — the snapshot figure is shown as installed, local activity beside it.
 */

function stockView(
  database: SqliteDatabase,
  repositories: RealRepositories,
  fixture: ReturnType<typeof setUpAuthorizedContext>
): StockViewService {
  return new StockViewService({
    database,
    catalog: fixture.catalog,
    bootstrapSnapshot: repositories.bootstrapSnapshot,
    stockAllocations: repositories.stockAllocations,
    offlineSaleAuthorities: repositories.offlineSaleAuthorities,
    clock: fixture.catalogClock,
    owner: () => ({ companyUuid, deviceUuid })
  })
}

function trackedView(service: StockViewService): Extract<ProductStockView, { kind: 'allocation' }> {
  const view = service.productForSale(trackedProductUuid).stock
  ok(view.kind === 'allocation', `expected allocation view, got ${view.kind}`)
  return view as Extract<ProductStockView, { kind: 'allocation' }>
}

function trackedIntent(quantity: string, amount: number): ReturnType<typeof validIntent> {
  return validIntent({
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity,
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount, reference: null }]
  })
}

function reinstall(
  repositories: RealRepositories,
  revision: string,
  generatedAt: string,
  available: number
): void {
  const source = bootstrapResource()
  repositories.bootstrapSnapshot.persistSnapshot(
    {
      ...source,
      server_time: generatedAt,
      stock_items: (source.stock_items ?? []).map((item) => ({
        ...item,
        available_quantity: available,
        quantity: available
      })),
      products: (source.products ?? []).map((product) => ({
        ...product,
        resolved_price: product.resolved_price
          ? { ...product.resolved_price, valid_until: '2026-01-08T00:00:00+00:00' }
          : null
      })),
      catalog_contract: {
        ...source.catalog_contract,
        revision,
        generated_at: generatedAt,
        valid_until: '2026-01-08T00:00:00+00:00'
      },
      stock_allocations: [
        allocationEnvelope({
          granted_quantity_milli: 5000,
          remaining_quantity_milli: 5000,
          consume_until: '2026-01-08T00:00:00+00:00'
        })
      ],
      stock_allocation_revision: BOOTSTRAP_ALLOCATION_REVISION + 1
    },
    generatedAt
  )
}

databaseTest(
  'a durable sale updates "sold here" and "reserved here" at once; the dated warehouse snapshot is never adjusted',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      const fixture = setUpAuthorizedContext(database, repositories)
      enableAllocationCapability(repositories, [
        allocationEnvelope({ granted_quantity_milli: 5000, remaining_quantity_milli: 5000 })
      ])
      const service = stockView(database, repositories, fixture)
      const before = trackedView(service)
      equal(before.warehouse.quantity, '100.000')
      equal(before.soldHereUnderCatalog, '0.000')
      equal(before.reservedHere, '5.000')
      equal(service.productForSale(productUuid).stock.kind, 'untracked')

      const sale = fixture.localSale.complete(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        trackedIntent('2.000', 1000)
      )
      equal(sale.outcome, 'committed')

      const after = trackedView(service)
      equal(after.warehouse.quantity, '100.000', 'the snapshot is shown as installed')
      equal(after.soldHereUnderCatalog, '2.000')
      equal(after.reservedHere, '3.000')
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a rejected checkout changes nothing; a restart and a replayed completion never count a sale twice',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const fixture = setUpAuthorizedContext(database, repositories)
    enableAllocationCapability(repositories, [
      allocationEnvelope({ granted_quantity_milli: 1000, remaining_quantity_milli: 1000 })
    ])

    // More than the grant covers, offline-capable path: definitive rejection, zero writes.
    const rejected = fixture.localSale.complete(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      trackedIntent('3.000', 1500)
    )
    equal(rejected.outcome, 'rejected')
    deepEqual(
      [trackedView(stockView(database, repositories, fixture)).soldHereUnderCatalog],
      ['0.000']
    )

    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    equal(fixture.localSale.complete(key, trackedIntent('1.000', 500)).outcome, 'committed')
    equal(fixture.localSale.complete(key, trackedIntent('1.000', 500)).outcome, 'committed')
    equal(trackedView(stockView(database, repositories, fixture)).soldHereUnderCatalog, '1.000')
    closeDatabase(database)

    const reopened = openExistingTestDatabase(sandbox)
    const reopenedRepositories = realRepositories(reopened)
    const restarted = setUpAuthorizedContext(
      reopened,
      reopenedRepositories,
      undefined,
      'online',
      false
    )
    const view = trackedView(stockView(reopened, reopenedRepositories, restarted))
    equal(view.soldHereUnderCatalog, '1.000')
    equal(view.reservedHere, '0.000')
    closeDatabase(reopened)
  }
)

databaseTest(
  'a new catalog install starts "sold here" from zero, re-installing the same revision keeps it, and the snapshot is shown as installed',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      let now = new Date('2026-01-01T02:00:00.000Z')
      const fixture = setUpAuthorizedContext(database, repositories, () => now)
      enableAllocationCapability(repositories, [
        allocationEnvelope({ granted_quantity_milli: 5000, remaining_quantity_milli: 5000 })
      ])
      equal(
        fixture.localSale.complete(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          trackedIntent('2.000', 1000)
        ).outcome,
        'committed'
      )
      const service = stockView(database, repositories, fixture)
      equal(trackedView(service).soldHereUnderCatalog, '2.000')

      // The server now reports 98 (it may or may not include this till's sale — the desktop does
      // not claim either); the local fact restarts under the new catalog version.
      now = new Date('2026-01-05T01:00:00.000Z')
      reinstall(repositories, 'b'.repeat(64), '2026-01-05T00:00:00+00:00', 98)
      const refreshed = trackedView(service)
      equal(refreshed.warehouse.quantity, '98.000')
      equal(Date.parse(refreshed.warehouse.asOf), Date.parse('2026-01-05T00:00:00Z'))
      equal(refreshed.soldHereUnderCatalog, '0.000')

      reinstall(repositories, 'b'.repeat(64), '2026-01-05T00:00:00+00:00', 98)
      equal(trackedView(service).soldHereUnderCatalog, '0.000')
    } finally {
      closeDatabase(database)
    }
  }
)
