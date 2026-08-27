import { deepEqual, equal, match, throws } from 'node:assert/strict'
import { CatalogReadAccessService } from '../../../src/main/services/catalogReadAccess.service'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogTrustedClockService } from '../../../src/main/services/catalogTrustedClock.service'
import { LICENSE_TRUSTED_TIME_ANCHOR_KEY } from '../../../src/main/repositories/licenseMetadata.repository'
import { normalizeCatalogSearch } from '../../../src/shared/catalog/normalization'
import { closeDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { databaseTest } from '../support/sandbox'
import { tableDigest } from '../support/committedState'
import { failingDatabase } from '../support/failingDatabase'
import {
  applyAllTestMigrations,
  openPreCatalogIntegrityTestDatabase,
  openTestDatabase
} from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

const DEVICE_UUID = '33333333-3333-4333-8333-333333333333'
const SERVER_DEVICE_ID = '22222222-2222-4222-8222-222222222222'

function laterSnapshot(): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()
  const catalogContract = {
    ...source.catalog_contract,
    revision: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    generated_at: '2026-01-02T00:00:00+00:00',
    valid_until: '2026-01-05T00:00:00+00:00'
  }

  return desktopBootstrapFixture({
    catalog_contract: catalogContract,
    products: (source.products ?? []).map((product) => ({
      ...product,
      resolved_price: product.resolved_price
        ? { ...product.resolved_price, valid_until: catalogContract.valid_until }
        : null
    }))
  })
}

function prepareAuthorizedCatalog(
  sandbox: Parameters<Parameters<typeof databaseTest>[1]>[0],
  permissions = ['pos.view']
): {
  readonly database: ReturnType<typeof openTestDatabase>
  readonly repositories: ReturnType<typeof realRepositories>
  readonly catalog: CatalogService
  readonly now: { value: string }
} {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  repositories.deviceIdentity.create({
    deviceUuid: DEVICE_UUID,
    deviceName: 'Example Register',
    platform: 'linux',
    osVersion: '6.0',
    appVersion: '1.0.0',
    isRegistered: true
  })
  repositories.deviceIdentity.markRegisteredWithBackend('2026-01-01T00:00:00+00:00')
  repositories.bootstrapSnapshot.persistSnapshot(
    desktopBootstrapFixture({ permissions }),
    '2026-01-01T00:01:00+00:00'
  )
  repositories.sessionMetadata.establish({
    userName: 'Cashier',
    userEmail: 'cashier@example.test',
    userUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userIsActive: true,
    companyUuid: '11111111-1111-4111-8111-111111111111',
    deviceUuid: DEVICE_UUID,
    serverDeviceId: SERVER_DEVICE_ID
  })
  repositories.appSettings.set(LICENSE_TRUSTED_TIME_ANCHOR_KEY, '2026-01-01T00:00:00.000Z')
  const now = { value: '2026-01-02T00:00:00.000Z' }
  const access = new CatalogReadAccessService({
    identity: repositories.deviceIdentity,
    deviceRegistration: repositories.deviceRegistration,
    session: repositories.sessionMetadata,
    secrets: { getSecret: () => 'desktop-token' },
    company: repositories.bootstrapSnapshot,
    permissions: repositories.bootstrapSnapshot
  })
  const clock = new CatalogTrustedClockService(repositories.appSettings, () => new Date(now.value))
  const catalog = new CatalogService(repositories.catalog, access, clock)

  return { database, repositories, catalog, now }
}

databaseTest(
  'every catalog publication write failure preserves the exact last-good snapshot',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      desktopBootstrapFixture(),
      '2026-01-01T00:01:00+00:00'
    )
    const tables = [
      'catalog_metadata',
      'catalog_categories',
      'catalog_products',
      'catalog_product_barcodes',
      'payment_methods',
      'customers',
      'bootstrap_state'
    ]
    const before = tables.map((table) => tableDigest(sandbox, table))
    const incoming = laterSnapshot()
    let failureNumber = 1

    while (true) {
      const failingRepository = realRepositories(
        failingDatabase(database, { failOnWriteNumber: failureNumber })
      ).bootstrapSnapshot
      let failed = false

      try {
        failingRepository.persistSnapshot(incoming, '2026-01-02T00:01:00+00:00')
      } catch (error) {
        match(String(error), /Injected SQLite write failure/)
        failed = true
      }

      if (!failed) {
        break
      }

      deepEqual(
        tables.map((table) => tableDigest(sandbox, table)),
        before,
        `write ${failureNumber} must leave every published catalog table unchanged`
      )
      failureNumber += 1
      if (failureNumber > 120) {
        throw new Error('Expected catalog publication to complete within 120 SQLite writes')
      }
    }

    equal(failureNumber > 20, true, 'all collection and completion writes were fault-injected')
    equal(repositories.catalog.getSnapshot()?.contract.revision, incoming.catalog_contract.revision)
    closeDatabase(database)
  }
)

databaseTest(
  'catalog revision ordering rejects old/conflicting snapshots and treats an equal revision as idempotent',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const snapshot = repositories.bootstrapSnapshot
    const initial = desktopBootstrapFixture()
    snapshot.persistSnapshot(initial, '2026-01-01T00:01:00+00:00')
    const beforeRows = tableDigest(sandbox, 'catalog_products')

    throws(
      () =>
        snapshot.persistSnapshot(
          desktopBootstrapFixture({
            catalog_contract: {
              ...initial.catalog_contract,
              revision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              generated_at: '2025-12-31T00:00:00+00:00'
            },
            products: [],
            product_barcodes: []
          }),
          '2026-01-01T00:02:00+00:00'
        ),
      (error: unknown) => {
        equal((error as { backendCode?: string }).backendCode, 'CATALOG_SNAPSHOT_OLDER')
        return true
      }
    )
    throws(
      () =>
        snapshot.persistSnapshot(
          desktopBootstrapFixture({
            catalog_contract: {
              ...initial.catalog_contract,
              revision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
            }
          }),
          '2026-01-01T00:02:00+00:00'
        ),
      (error: unknown) => {
        equal((error as { backendCode?: string }).backendCode, 'CATALOG_REVISION_CONFLICT')
        return true
      }
    )

    snapshot.persistSnapshot(initial, '2026-01-01T00:03:00+00:00')
    equal(tableDigest(sandbox, 'catalog_products'), beforeRows)
    equal(repositories.catalog.getSnapshot()?.fetchedAt, '2026-01-01T00:03:00+00:00')
    closeDatabase(database)
  }
)

databaseTest(
  'trusted catalog provenance distinguishes fresh, cached, stale, and rollback-safe states',
  (sandbox) => {
    const { database, catalog, now } = prepareAuthorizedCatalog(sandbox)

    equal(catalog.getStatus().status, 'cached')
    catalog.markPublished('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    equal(catalog.getStatus().status, 'fresh')
    now.value = '2026-01-04T00:00:00.000Z'
    equal(catalog.getStatus().status, 'stale')
    now.value = '2026-01-02T00:00:00.000Z'
    equal(catalog.getStatus().status, 'stale', 'rollback must not restore catalog validity')
    equal(catalog.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).total, 1)
    closeDatabase(database)
  }
)

databaseTest(
  'a clock rollback inside the validity window keeps the cached catalog readable',
  (sandbox) => {
    const { database, catalog, now } = prepareAuthorizedCatalog(sandbox)

    equal(catalog.getStatus().status, 'cached')

    // Roll the wall clock far back while the snapshot is still inside its validity window. The
    // trusted high-water mark must hold the decision at `cached` rather than hiding every row.
    now.value = '2025-06-01T00:00:00.000Z'
    const rolledBack = catalog.getStatus()
    equal(rolledBack.status, 'cached', 'rollback must not make a valid catalog unavailable')
    equal(rolledBack.isReadable, true)
    equal(rolledBack.catalogValid, true)
    equal(catalog.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).total, 1)
    closeDatabase(database)
  }
)

databaseTest(
  'a session without pos.view is denied every catalog read while durable rows are retained',
  (sandbox) => {
    const { database, catalog, repositories } = prepareAuthorizedCatalog(sandbox, [
      'pos.sell',
      'shifts.manage'
    ])

    deepEqual(catalog.getStatus(), {
      status: 'unavailable',
      isReadable: false,
      catalogValid: false,
      lastSyncedAt: null,
      contract: null
    })

    const denied = (call: () => unknown): void => {
      throws(call, (error: unknown) => {
        equal((error as { backendCode?: string }).backendCode, 'CATALOG_READ_ACCESS_DENIED')
        equal((error as { category?: string }).category, 'authorization')
        return true
      })
    }

    denied(() => catalog.listCategories())
    denied(() => catalog.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }))
    denied(() => catalog.getProduct('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
    denied(() => catalog.listPaymentMethods())
    denied(() => catalog.searchCustomers({ query: '', limit: 24, offset: 0 }))
    denied(() => catalog.getCustomer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))

    // Barcode lookup fails closed through a sanitized outcome instead of an authorization error.
    deepEqual(catalog.findProductByBarcode('4006381333931'), { outcome: 'unavailable-catalog' })

    // Denial is an authorization decision only — the persisted snapshot must survive it intact.
    equal(repositories.catalog.getSnapshot()?.manifest.products, 1)
    closeDatabase(database)
  }
)

databaseTest(
  'catalog read access requires pos.view and a matching device/session/company context, not pos.sell',
  (sandbox) => {
    const { database, catalog, repositories } = prepareAuthorizedCatalog(sandbox, ['pos.view'])
    equal(catalog.getStatus().isReadable, true)
    equal(catalog.searchProducts({ query: '', categoryUuid: null, limit: 24, offset: 0 }).total, 1)

    repositories.sessionMetadata.establish({
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userIsActive: true,
      companyUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      deviceUuid: DEVICE_UUID,
      serverDeviceId: SERVER_DEVICE_ID
    })
    const sanitized = catalog.getStatus()
    deepEqual(sanitized, {
      status: 'unavailable',
      isReadable: false,
      catalogValid: false,
      lastSyncedAt: null,
      contract: null
    })
    throws(
      () => catalog.listCategories(),
      (error: unknown) => {
        equal((error as { backendCode?: string }).backendCode, 'CATALOG_READ_ACCESS_DENIED')
        return true
      }
    )
    closeDatabase(database)
  }
)

databaseTest(
  'customer search is normalized, bounded, deduplicated, indexed, and omits unrelated customer data',
  (sandbox) => {
    const resource = desktopBootstrapFixture({
      customers: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: '  Åsa   Market ',
          email: 'private@example.test',
          phone: ' 010  123 ',
          tax_number: 'tax',
          address: 'private address',
          notes: 'private notes',
          is_active: true,
          updated_at: '2026-01-01T00:00:00+00:00'
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          name: 'Asa Market Two',
          email: null,
          phone: '010 456',
          tax_number: null,
          address: null,
          notes: null,
          is_active: true,
          updated_at: '2026-01-01T00:00:00+00:00'
        }
      ],
      payment_methods: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: 'Cash',
          code: 'cash',
          type: 'cash',
          is_active: true,
          allows_change: true,
          requires_reference: false,
          sort_order: 1,
          updated_at: '2026-01-01T00:00:00+00:00'
        }
      ]
    })
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(resource, '2026-01-01T00:01:00+00:00')
    const customers = repositories.catalog.searchCustomers({ query: '  010 ', limit: 1, offset: 0 })

    equal(customers.total, 2)
    equal(customers.items.length, 1)
    deepEqual(Object.keys(customers.items[0] ?? {}).sort(), ['name', 'phone', 'uuid'])
    equal(normalizeCatalogSearch('  Åsa   Market '), 'åsa market')
    deepEqual(repositories.catalog.listPaymentMethods(), [
      {
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Cash',
        code: 'cash',
        type: 'cash',
        isActive: true,
        allowsChange: true,
        requiresReference: false,
        sortOrder: 1
      }
    ])

    const plan = database
      .prepare(
        `
        EXPLAIN QUERY PLAN
        SELECT id FROM customers
        WHERE is_active = 1 AND search_name >= ? AND search_name < ?
        UNION
        SELECT id FROM customers
        WHERE is_active = 1 AND search_phone >= ? AND search_phone < ?
      `
      )
      .all('010', '010\uffff', '010', '010\uffff') as Array<{ readonly detail: string }>
    equal(
      plan.some((row) => row.detail.includes('idx_catalog_customers')),
      true
    )
    closeDatabase(database)
  }
)

const CHECKOUT_PRODUCT_UUID = '55555555-5555-4555-8555-555555555555'
const CHECKOUT_ACTIVE_METHOD_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CHECKOUT_INACTIVE_METHOD_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CHECKOUT_CUSTOMER_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CHECKOUT_UNKNOWN_UUID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function checkoutResolutionFixture(): ReturnType<typeof desktopBootstrapFixture> {
  return desktopBootstrapFixture({
    payment_methods: [
      {
        id: CHECKOUT_ACTIVE_METHOD_UUID,
        name: 'Cash',
        code: 'cash',
        type: 'cash',
        is_active: true,
        allows_change: true,
        requires_reference: false,
        sort_order: 1,
        updated_at: '2026-01-01T00:00:00+00:00'
      },
      {
        id: CHECKOUT_INACTIVE_METHOD_UUID,
        name: 'Retired Card Reader',
        code: 'card-old',
        type: 'card',
        is_active: false,
        allows_change: false,
        requires_reference: true,
        sort_order: 2,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
    customers: [
      {
        id: CHECKOUT_CUSTOMER_UUID,
        name: 'Walk-in',
        email: null,
        phone: null,
        tax_number: null,
        address: null,
        notes: null,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ]
  })
}

databaseTest(
  'resolveForCheckout returns a mutually consistent snapshot in one transaction',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const resource = checkoutResolutionFixture()
    repositories.bootstrapSnapshot.persistSnapshot(resource, '2026-01-01T00:01:00+00:00')

    const resolution = repositories.catalog.resolveForCheckout({
      productUuids: [CHECKOUT_PRODUCT_UUID],
      paymentMethodUuids: [CHECKOUT_ACTIVE_METHOD_UUID],
      customerUuid: CHECKOUT_CUSTOMER_UUID
    })

    equal(resolution?.contract.revision, resource.catalog_contract.revision)
    equal(resolution?.snapshotRevision, resource.catalog_contract.revision)
    equal(resolution?.products.length, 1)
    equal(resolution?.products[0]?.uuid, CHECKOUT_PRODUCT_UUID)
    equal(resolution?.products[0]?.price.revision, resource.products?.[0]?.resolved_price?.revision)
    equal(resolution?.products[0]?.tax.revision, resource.products?.[0]?.resolved_tax?.revision)
    equal(resolution?.customer?.uuid, CHECKOUT_CUSTOMER_UUID)
    closeDatabase(database)
  }
)

databaseTest(
  'resolveForCheckout resolves an inactive payment method as data while the picker omits it',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      checkoutResolutionFixture(),
      '2026-01-01T00:01:00+00:00'
    )

    const picker = repositories.catalog.listPaymentMethods()
    equal(
      picker.some((method) => method.uuid === CHECKOUT_INACTIVE_METHOD_UUID),
      false
    )

    const resolution = repositories.catalog.resolveForCheckout({
      productUuids: [CHECKOUT_PRODUCT_UUID],
      paymentMethodUuids: [CHECKOUT_ACTIVE_METHOD_UUID, CHECKOUT_INACTIVE_METHOD_UUID],
      customerUuid: null
    })

    equal(resolution?.paymentMethods.length, 2)
    const inactive = resolution?.paymentMethods.find(
      (method) => method.uuid === CHECKOUT_INACTIVE_METHOD_UUID
    )
    equal(inactive?.isActive, false)
    const active = resolution?.paymentMethods.find(
      (method) => method.uuid === CHECKOUT_ACTIVE_METHOD_UUID
    )
    equal(active?.isActive, true)
    closeDatabase(database)
  }
)

databaseTest(
  'resolveForCheckout leaves an unresolved payment method absent rather than failing the snapshot',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      checkoutResolutionFixture(),
      '2026-01-01T00:01:00+00:00'
    )

    const resolution = repositories.catalog.resolveForCheckout({
      productUuids: [CHECKOUT_PRODUCT_UUID],
      paymentMethodUuids: [CHECKOUT_ACTIVE_METHOD_UUID, CHECKOUT_UNKNOWN_UUID],
      customerUuid: null
    })

    equal(resolution?.paymentMethods.length, 1)
    equal(resolution?.paymentMethods[0]?.uuid, CHECKOUT_ACTIVE_METHOD_UUID)
    closeDatabase(database)
  }
)

databaseTest(
  'resolveForCheckout fails the whole snapshot closed on a missing product or a missing customer',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.bootstrapSnapshot.persistSnapshot(
      checkoutResolutionFixture(),
      '2026-01-01T00:01:00+00:00'
    )

    equal(
      repositories.catalog.resolveForCheckout({
        productUuids: [CHECKOUT_PRODUCT_UUID, CHECKOUT_UNKNOWN_UUID],
        paymentMethodUuids: [],
        customerUuid: null
      }),
      null
    )
    equal(
      repositories.catalog.resolveForCheckout({
        productUuids: [CHECKOUT_PRODUCT_UUID],
        paymentMethodUuids: [],
        customerUuid: CHECKOUT_UNKNOWN_UUID
      }),
      null
    )
    // A null customerUuid is not a request for a customer at all, so it never fails resolution.
    const withoutCustomer = repositories.catalog.resolveForCheckout({
      productUuids: [CHECKOUT_PRODUCT_UUID],
      paymentMethodUuids: [],
      customerUuid: null
    })
    equal(withoutCustomer?.customer, null)
    closeDatabase(database)
  }
)

databaseTest(
  'the catalog migration backfills search keys with the same normalizer used at runtime',
  (sandbox) => {
    const database = openPreCatalogIntegrityTestDatabase(sandbox)
    database
      .prepare(
        `
        INSERT INTO catalog_categories (uuid, name, search_name, is_active, updated_at)
        VALUES (?, ?, ?, 1, NULL)
      `
      )
      .run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '  Åsa   Drinks ', 'outdated')
    database
      .prepare(
        `
        INSERT INTO catalog_products (
          uuid, category_uuid, name, search_name, sku, search_sku, barcode, description,
          status, is_active, track_stock, unit, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'inactive', 0, 0, NULL, NULL)
      `
      )
      .run(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '  Åsa   Water ',
        'outdated',
        ' SKU  01 ',
        'outdated'
      )
    database
      .prepare(
        `
        INSERT INTO customers (id, name, email, phone, tax_number, address, notes, is_active, updated_at)
        VALUES (?, ?, NULL, ?, NULL, NULL, NULL, 1, NULL)
      `
      )
      .run('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '  Åsa   Customer ', ' 010  123 ')

    applyAllTestMigrations(database)
    const row = database
      .prepare('SELECT search_name, search_phone FROM customers WHERE id = ?')
      .get('cccccccc-cccc-4ccc-8ccc-cccccccccccc') as {
      readonly search_name: string
      readonly search_phone: string
    }
    const product = database
      .prepare('SELECT search_name, search_sku FROM catalog_products WHERE uuid = ?')
      .get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') as {
      readonly search_name: string
      readonly search_sku: string | null
    }

    deepEqual(row, {
      search_name: normalizeCatalogSearch('  Åsa   Customer '),
      search_phone: normalizeCatalogSearch(' 010  123 ')
    })
    deepEqual(product, {
      search_name: normalizeCatalogSearch('  Åsa   Water '),
      search_sku: normalizeCatalogSearch(' SKU  01 ')
    })
    closeDatabase(database)
  }
)
