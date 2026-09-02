import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogRefreshService } from '../../../src/main/services/catalogRefresh.service'
import type { StockAllocationResource } from '../../../src/main/http/desktopResources.contract'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import type {
  CommercialAccessAction,
  CommercialAccessDecision
} from '../../../src/shared/contracts/license.contract'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  companyUuid,
  deviceUuid,
  methodUuid,
  setUpAuthorizedContext,
  trackedProductUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/**
 * The durable half of `catalog:refresh`, on the real shipped Electron SQLite ABI.
 *
 * The network half (`DesktopApiClient` → `/api/v1/desktop/bootstrap`) is covered by the
 * `BootstrapService`/`CatalogRefreshService` vitest suites. What can only be proven here is what
 * the refresh actually does to the on-disk snapshot: that the whole cached catalogue is replaced
 * in one transaction, that a failed refresh leaves the previous catalogue intact and sellable,
 * and that catalog status is recalculated from the newly committed rows.
 */

const REVISION_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REVISION_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const WAREHOUSE_UUID = '88888888-8888-4888-8888-888888888888'
const CASH_METHOD_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CARD_METHOD_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ALLOCATION_UUID = '70000000-0000-4000-8000-000000000001'

function activeAllocation(
  revisionOverrides: Partial<StockAllocationResource> = {}
): StockAllocationResource {
  return {
    id: ALLOCATION_UUID,
    contract_version: 1,
    company_uuid: companyUuid,
    device_uuid: deviceUuid,
    warehouse_uuid: warehouseUuid,
    product_uuid: trackedProductUuid,
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 1000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 1000,
    consume_until: '2027-01-01T00:00:00+00:00',
    status: 'active',
    envelope_hash: 'd'.repeat(64),
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null,
    ...revisionOverrides
  }
}

function allocationSaleIntent(quantity = '1.000'): ReturnType<typeof validIntent> {
  return validIntent({
    items: [
      {
        id: 'tracked-line',
        productUuid: trackedProductUuid,
        quantity,
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [
      {
        id: 'payment-1',
        paymentMethodUuid: methodUuid,
        amount: Number(quantity) * 500,
        reference: null
      }
    ]
  })
}

// The fixture ships no payment methods by default, so both snapshots declare them explicitly.
const cashMethod = {
  id: CASH_METHOD_UUID,
  name: 'Cash',
  code: 'cash',
  type: 'cash',
  is_active: true,
  allows_change: true,
  requires_reference: false,
  sort_order: 1,
  updated_at: '2026-01-01T00:00:00+00:00'
} as const

const cardMethod = {
  id: CARD_METHOD_UUID,
  name: 'Card',
  code: 'card',
  type: 'card',
  is_active: true,
  allows_change: false,
  requires_reference: true,
  sort_order: 2,
  updated_at: '2026-01-02T00:00:00+00:00'
} as const

const allowedAccess = {
  evaluate: () => ({ allowed: true }),
  assertAllowed: () => undefined
}

function clock(value: string): { now: () => { now: Date; rollbackDetected: boolean } } {
  return { now: () => ({ now: new Date(value), rollbackDetected: false }) }
}

function allowedDecision(action: CommercialAccessAction): CommercialAccessDecision {
  return {
    allowed: true,
    reason: null,
    warning: null,
    action,
    retryable: false,
    evaluatedAt: '2026-01-02T00:00:00+00:00',
    nextValidationDueAt: null,
    restrictionLevel: null,
    warningMessage: null
  }
}

/** The catalogue the workstation is already selling against before any refresh. */
function firstSnapshot(): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()
  const [product] = source.products ?? []

  return desktopBootstrapFixture({
    warehouse: { id: WAREHOUSE_UUID, name: 'Main Warehouse', is_active: true },
    products: [{ ...product, name: 'Sparkling Water' }],
    payment_methods: [cashMethod],
    stock_items: [
      {
        id: '99999999-9999-4999-8999-999999999998',
        product_uuid: product.uuid,
        warehouse_uuid: WAREHOUSE_UUID,
        quantity: 10,
        reserved_quantity: 0,
        allocation_reserved_quantity: 0,
        available_quantity: 10,
        minimum_quantity: null,
        maximum_quantity: null,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ]
  })
}

/**
 * A genuinely newer server catalogue: a new revision, a renamed and repriced product, a second
 * payment method, and a different warehouse quantity — every class of data the refresh claims to
 * replace.
 */
function secondSnapshot(): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()
  const [product] = source.products ?? []

  return desktopBootstrapFixture({
    warehouse: { id: WAREHOUSE_UUID, name: 'Main Warehouse', is_active: true },
    catalog_contract: {
      ...source.catalog_contract,
      revision: REVISION_B,
      generated_at: '2026-01-02T00:00:00+00:00',
      valid_until: '2026-01-06T00:00:00+00:00'
    },
    products: [
      {
        ...product,
        name: 'Still Water',
        // `valid_until` must track the issued contract exactly — `assertCatalogSemantics` rejects a
        // product whose price window disagrees with the contract it was issued under.
        resolved_price: product.resolved_price
          ? {
              ...product.resolved_price,
              amount: 1750,
              revision: REVISION_B,
              valid_until: '2026-01-06T00:00:00+00:00'
            }
          : null
      }
    ],
    payment_methods: [cashMethod, cardMethod],
    stock_items: [
      {
        id: '99999999-9999-4999-8999-999999999998',
        product_uuid: product.uuid,
        warehouse_uuid: WAREHOUSE_UUID,
        quantity: 4,
        reserved_quantity: 0,
        allocation_reserved_quantity: 0,
        available_quantity: 4,
        minimum_quantity: null,
        maximum_quantity: null,
        is_active: true,
        updated_at: '2026-01-02T00:00:00+00:00'
      }
    ]
  })
}

databaseTest(
  'a refresh replaces catalog, payment methods, customers and warehouse stock together',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

    repositories.bootstrapSnapshot.persistSnapshot(firstSnapshot(), '2026-01-01T00:01:00+00:00')

    const before = realRepositories(database).catalog
    equal(before.getContract()?.revision, REVISION_A)
    equal(
      before.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).items[0]?.name,
      'Sparkling Water'
    )
    equal(before.listPaymentMethods().length, 1)

    repositories.bootstrapSnapshot.persistSnapshot(secondSnapshot(), '2026-01-02T00:01:00+00:00')

    const after = realRepositories(database).catalog
    equal(after.getContract()?.revision, REVISION_B)
    const products = after.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 })
    // One product, replaced — never the old row left beside the new one.
    equal(products.total, 1)
    equal(products.items[0]?.name, 'Still Water')
    equal(products.items[0]?.price.amount, 1750)
    equal(products.items[0]?.availableQuantity, '4.000')
    equal(after.listPaymentMethods().length, 2)

    closeDatabase(database)
  }
)

databaseTest(
  'a refresh recalculates a stale catalog to fresh from the committed rows',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(firstSnapshot(), '2026-01-01T00:01:00+00:00')

    // 2026-01-05 is past the first contract's valid_until (2026-01-04) — genuinely stale.
    const staleAt = clock('2026-01-05T00:00:00+00:00')
    const beforeService = new CatalogService(repositories.catalog, allowedAccess, staleAt)
    equal(beforeService.getStatus().status, 'stale')

    repositories.bootstrapSnapshot.persistSnapshot(secondSnapshot(), '2026-01-05T00:01:00+00:00')

    // The very same wall-clock instant now reads as usable, because the committed contract moved.
    const afterService = new CatalogService(
      realRepositories(database).catalog,
      allowedAccess,
      staleAt
    )
    const status = afterService.getStatus()
    notEqual(status.status, 'stale')
    equal(status.catalogValid, true)
    equal(status.contract?.revision, REVISION_B)

    closeDatabase(database)
  }
)

databaseTest(
  'the refresh service reports the revision change that forces an explicit cart rebuild',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(firstSnapshot(), '2026-01-01T00:01:00+00:00')

    const catalog = new CatalogService(
      repositories.catalog,
      allowedAccess,
      clock('2026-01-02T00:00:00+00:00')
    )
    const service = new CatalogRefreshService({
      // The license leg has its own vitest coverage; here it is a no-op so the assertions stay on
      // what only the real SQLite ABI can prove — what the refresh does to the on-disk snapshot.
      license: { validate: async () => licenseStatusFixture() },
      authorizer: { ensureCatalogReadContext: async () => undefined },
      shiftReconciler: { current: async () => null },
      catalog,
      access: {
        describe: () => ({
          sell: allowedDecision('sell'),
          sync: allowedDecision('sync')
        })
      },
      accessPublisher: { begin: () => 1, publish: () => undefined },
      // Stands in for the network leg only: it performs the real persistence the live
      // BootstrapService performs, against this real database.
      source: {
        refresh: async () => {
          const persisted = repositories.bootstrapSnapshot.persistSnapshot(
            secondSnapshot(),
            '2026-01-02T00:01:00+00:00'
          )
          return {
            isComplete: true,
            snapshotVersion: persisted.snapshotVersion,
            serverTime: persisted.serverTime,
            fetchedAt: '2026-01-02T00:01:00+00:00',
            counts: persisted.counts,
            catalog: {
              revision: REVISION_B,
              generatedAt: '2026-01-02T00:00:00+00:00',
              validUntil: '2026-01-06T00:00:00+00:00'
            }
          }
        }
      }
    })

    const result = await service.refresh()

    equal(result.previousRevision, REVISION_A)
    equal(result.revisionChanged, true)
    equal(result.refreshedAt, '2026-01-02T00:01:00+00:00')
    // Status is recalculated from the rows this refresh just committed, not from a cached value.
    equal(result.status.contract?.revision, REVISION_B)
    equal(result.status.catalogValid, true)

    closeDatabase(database)
  }
)

databaseTest(
  'a rejected older snapshot rolls back nothing and leaves the active catalog sellable',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(secondSnapshot(), '2026-01-02T00:01:00+00:00')

    // A server response older than the active catalogue must never silently downgrade the
    // workstation. The guard rejects it before the replacement transaction runs.
    throws(() =>
      repositories.bootstrapSnapshot.persistSnapshot(firstSnapshot(), '2026-01-03T00:01:00+00:00')
    )

    const catalog = realRepositories(database).catalog
    equal(catalog.getContract()?.revision, REVISION_B)
    const products = catalog.searchProducts({
      query: '',
      categoryUuid: null,
      limit: 24,
      offset: 0
    })
    equal(products.total, 1)
    equal(products.items[0]?.name, 'Still Water')
    // The catalogue on disk is byte-for-byte the newer one — no partial replacement survived.
    equal(readCommitted(sandbox, 'SELECT * FROM catalog_products').length, 1)
    equal(
      readCommitted<{ revision: string }>(sandbox, 'SELECT revision FROM catalog_metadata')[0]
        ?.revision,
      REVISION_B
    )

    closeDatabase(database)
  }
)

databaseTest('a refresh never fabricates or destroys local allocation evidence', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  repositories.bootstrapSnapshot.persistSnapshot(firstSnapshot(), '2026-01-01T00:01:00+00:00')

  // This fixture represents a backend that predates allocation bootstrap support. The persisted
  // capability records that absence, so no retained allocation can silently remain sellable.
  equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)

  repositories.bootstrapSnapshot.persistSnapshot(secondSnapshot(), '2026-01-02T00:01:00+00:00')

  equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 0)
  // Committed sales evidence is likewise untouched by a catalogue replacement.
  equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 0)
  equal(readCommitted(sandbox, 'SELECT * FROM sale_attempts').length, 0)

  closeDatabase(database)
})

databaseTest(
  'a stale backend refresh cannot resurrect a locally consumed allocation',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(
      database,
      repositories,
      () => new Date('2026-01-01T02:00:00.000Z'),
      'offline'
    )
    const owner = { companyUuid, deviceUuid, warehouseUuid }
    const allocation = activeAllocation()
    const snapshot = bootstrapResource({
      stock_allocations: [allocation],
      stock_allocation_revision: 1
    })

    // Real full-snapshot entry point: no row helper is used.
    repositories.bootstrapSnapshot.persistSnapshot(snapshot, '2026-01-01T01:30:00+00:00')
    equal(readCommitted(sandbox, 'SELECT * FROM stock_allocation_grants').length, 1)
    equal(
      repositories.stockAllocations.usableGrantsForProduct(
        owner,
        trackedProductUuid,
        '2026-01-01T02:00:00+00:00'
      ).length,
      1
    )
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 1000)

    const first = localSale.complete('a0000000-0000-4000-8000-000000000001', allocationSaleIntent())
    ok(first.outcome === 'committed')
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_items').length, 1)
    equal(
      readCommitted<{ track_stock: number }>(
        sandbox,
        'SELECT track_stock FROM local_invoice_items'
      )[0]?.track_stock,
      1
    )
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoice_payments').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 1)
    equal(
      readCommitted<{ quantity_milli: number; server_status: string }>(
        sandbox,
        'SELECT quantity_milli, server_status FROM local_stock_allocation_consumptions'
      )[0]?.quantity_milli,
      1000
    )
    equal(
      readCommitted<{ server_status: string }>(
        sandbox,
        'SELECT server_status FROM local_stock_allocation_consumptions'
      )[0]?.server_status,
      'pending'
    )
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      1
    )
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 0)

    const businessDigests = {
      invoices: tableDigest(sandbox, 'local_invoices'),
      items: tableDigest(sandbox, 'local_invoice_items'),
      payments: tableDigest(sandbox, 'local_invoice_payments'),
      movements: tableDigest(sandbox, 'local_stock_movements'),
      consumptions: tableDigest(sandbox, 'local_stock_allocation_consumptions'),
      queue: tableDigest(sandbox, 'sync_queue')
    }

    // Laravel has not seen the local sale yet and honestly still reports active/0/full.
    repositories.bootstrapSnapshot.persistSnapshot(
      bootstrapResource({ stock_allocations: [activeAllocation()], stock_allocation_revision: 2 }),
      '2026-01-01T02:30:00+00:00'
    )

    equal(tableDigest(sandbox, 'local_invoices'), businessDigests.invoices)
    equal(tableDigest(sandbox, 'local_invoice_items'), businessDigests.items)
    equal(tableDigest(sandbox, 'local_invoice_payments'), businessDigests.payments)
    equal(tableDigest(sandbox, 'local_stock_movements'), businessDigests.movements)
    equal(tableDigest(sandbox, 'local_stock_allocation_consumptions'), businessDigests.consumptions)
    equal(tableDigest(sandbox, 'sync_queue'), businessDigests.queue)
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 0)

    // Connectivity is explicitly offline, so no top-up is available. The second sale becomes the
    // existing terminal allocation rejection while every business table remains byte-identical.
    const attemptsBefore = readCommitted(sandbox, 'SELECT * FROM sale_attempts').length
    const second = localSale.complete(
      'a0000000-0000-4000-8000-000000000002',
      allocationSaleIntent()
    )
    deepEqual(second, {
      outcome: 'rejected',
      attemptKey: 'a0000000-0000-4000-8000-000000000002',
      failureCode: 'stock-allocation-unavailable',
      affectedLineIds: ['tracked-line']
    })
    equal(tableDigest(sandbox, 'local_invoices'), businessDigests.invoices)
    equal(tableDigest(sandbox, 'local_invoice_items'), businessDigests.items)
    equal(tableDigest(sandbox, 'local_invoice_payments'), businessDigests.payments)
    equal(tableDigest(sandbox, 'local_stock_movements'), businessDigests.movements)
    equal(tableDigest(sandbox, 'local_stock_allocation_consumptions'), businessDigests.consumptions)
    equal(tableDigest(sandbox, 'sync_queue'), businessDigests.queue)
    equal(readCommitted(sandbox, 'SELECT * FROM sale_attempts').length, attemptsBefore + 1)
    equal(
      readCommitted<{ state: string }>(
        sandbox,
        "SELECT state FROM sale_attempts WHERE attempt_key = 'a0000000-0000-4000-8000-000000000002'"
      )[0]?.state,
      'rejected'
    )

    closeDatabase(database)
    const reopened = openExistingTestDatabase(sandbox)
    const reopenedRepositories = realRepositories(reopened)
    equal(reopenedRepositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 0)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_movements').length, 1)
    equal(
      readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'").length,
      1
    )
    closeDatabase(reopened)
  }
)

databaseTest(
  'refresh subtracts multiple partial pending consumptions exactly once and ignores untracked sales',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { localSale } = setUpAuthorizedContext(
      database,
      repositories,
      () => new Date('2026-01-01T02:00:00.000Z'),
      'offline'
    )
    repositories.bootstrapSnapshot.persistSnapshot(
      bootstrapResource({ stock_allocations: [activeAllocation()], stock_allocation_revision: 1 }),
      '2026-01-01T01:30:00+00:00'
    )

    ok(
      localSale.complete('b0000000-0000-4000-8000-000000000001', allocationSaleIntent('0.250'))
        .outcome === 'committed'
    )
    ok(
      localSale.complete('b0000000-0000-4000-8000-000000000002', allocationSaleIntent('0.250'))
        .outcome === 'committed'
    )
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 2)
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 500)

    repositories.bootstrapSnapshot.persistSnapshot(
      bootstrapResource({ stock_allocations: [activeAllocation()], stock_allocation_revision: 2 }),
      '2026-01-01T02:30:00+00:00'
    )
    equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 2)
    equal(
      readCommitted<{ total: number }>(
        sandbox,
        "SELECT SUM(quantity_milli) AS total FROM local_stock_allocation_consumptions WHERE server_status = 'pending'"
      )[0]?.total,
      500
    )
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 500)

    const consumptionsBefore = tableDigest(sandbox, 'local_stock_allocation_consumptions')
    const movementsBefore = tableDigest(sandbox, 'local_stock_movements')
    ok(
      localSale.complete('b0000000-0000-4000-8000-000000000003', validIntent()).outcome ===
        'committed'
    )
    equal(tableDigest(sandbox, 'local_stock_allocation_consumptions'), consumptionsBefore)
    equal(tableDigest(sandbox, 'local_stock_movements'), movementsBefore)
    equal(repositories.stockAllocations.remainingMilli(ALLOCATION_UUID), 500)
    closeDatabase(database)
  }
)

databaseTest('the replaced catalog survives a reopen of the same database file', (sandbox) => {
  const database = openTestDatabase(sandbox)
  realRepositories(database).bootstrapSnapshot.persistSnapshot(
    firstSnapshot(),
    '2026-01-01T00:01:00+00:00'
  )
  realRepositories(database).bootstrapSnapshot.persistSnapshot(
    secondSnapshot(),
    '2026-01-02T00:01:00+00:00'
  )
  closeDatabase(database)

  const reopened = openExistingTestDatabase(sandbox)
  const catalog = realRepositories(reopened).catalog
  equal(catalog.getContract()?.revision, REVISION_B)
  deepEqual(
    catalog.listPaymentMethods().map((method) => method.code),
    ['cash', 'card']
  )
  ok(catalog.getContract()?.validUntil.startsWith('2026-01-06'))

  closeDatabase(reopened)
})
