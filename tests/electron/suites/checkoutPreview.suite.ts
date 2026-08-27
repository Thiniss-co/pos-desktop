import { deepEqual, equal } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { CatalogReadAccessService } from '../../../src/main/services/catalogReadAccess.service'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogTrustedClockService } from '../../../src/main/services/catalogTrustedClock.service'
import { CheckoutPreviewService } from '../../../src/main/services/checkoutPreview.service'
import { CommercialAccessService } from '../../../src/main/services/commercialAccess.service'
import { SessionService } from '../../../src/main/services/session.service'
import { ShiftAuthorityService } from '../../../src/main/services/shiftAuthority.service'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import { databaseTest } from '../support/sandbox'
import { readCommitted, tableDigest } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

const companyUuid = '11111111-1111-4111-8111-111111111111'
const serverDeviceId = '22222222-2222-4222-8222-222222222222'
const deviceUuid = '33333333-3333-4333-8333-333333333333'
const userUuid = '44444444-4444-4444-8444-444444444444'
const productUuid = '55555555-5555-4555-8555-555555555555'
const methodUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const shiftUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function bootstrapResource(): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()

  return desktopBootstrapFixture({
    permissions: ['pos.view', 'pos.sell'],
    products: (source.products ?? []).map((product) => ({
      ...product,
      resolved_price: product.resolved_price ? { ...product.resolved_price, amount: 1000 } : null,
      resolved_tax: { id: null, mode: 'none', rate_basis_points: 0, revision: 'c'.repeat(64) }
    })),
    payment_methods: [
      {
        id: methodUuid,
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
}

function validIntent(overrides: Partial<CheckoutIntent> = {}): CheckoutIntent {
  return {
    draftRevision: 1,
    catalogRevision: bootstrapResource().catalog_contract.revision,
    items: [{ id: 'item-1', productUuid, quantity: '1.000', discountType: null, discountValue: 0 }],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }],
    ...overrides
  }
}

function setUpAuthorizedContext(
  database: SqliteDatabase,
  repositories: RealRepositories
): { checkoutPreview: CheckoutPreviewService; authority: ShiftAuthorityService } {
  repositories.deviceIdentity.create({
    deviceUuid,
    deviceName: 'Example Register',
    platform: 'linux',
    osVersion: '6.0',
    appVersion: '1.0.0',
    isRegistered: true
  })
  repositories.deviceIdentity.markRegisteredWithBackend('2026-01-01T00:00:00Z')
  repositories.deviceRegistration.set({
    serverDeviceId,
    status: 'active',
    lastSeenAt: null,
    updatedAt: '2026-01-01T00:00:00Z'
  })
  repositories.bootstrapSnapshot.persistSnapshot(bootstrapResource(), '2026-01-01T00:01:00+00:00')
  repositories.licenseMetadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')

  const session = new SessionService(
    repositories.sessionMetadata,
    { deleteSecret: () => undefined },
    { database, epoch: repositories.sessionEpoch, observations: repositories.shiftObservations }
  )
  session.startSession({
    userName: 'Cashier',
    userEmail: 'cashier@example.test',
    userUuid,
    userIsActive: true,
    companyUuid,
    deviceUuid,
    serverDeviceId
  })

  const authority = new ShiftAuthorityService({
    observations: repositories.shiftObservations,
    session: repositories.sessionMetadata,
    company: repositories.bootstrapSnapshot,
    device: {
      getOrCreate: () => {
        const identity = repositories.deviceIdentity.get()
        if (!identity) {
          throw new Error('Test device identity is unavailable')
        }
        return identity
      }
    },
    epoch: repositories.sessionEpoch,
    now: () => new Date('2026-01-01T01:00:00.000Z')
  })
  const context = authority.captureContext()
  repositories.shiftObservations.write({
    kind: 'shift',
    ...context,
    shiftUuid,
    status: 'open',
    openedAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-01T01:00:00.000Z',
    source: 'current'
  })

  const catalogReadAccess = new CatalogReadAccessService({
    identity: repositories.deviceIdentity,
    deviceRegistration: repositories.deviceRegistration,
    session: repositories.sessionMetadata,
    secrets: { getSecret: () => 'desktop-token' },
    company: repositories.bootstrapSnapshot,
    permissions: repositories.bootstrapSnapshot
  })
  const catalogClock = new CatalogTrustedClockService(
    repositories.appSettings,
    () => new Date('2026-01-01T02:00:00.000Z')
  )
  const catalog = new CatalogService(repositories.catalog, catalogReadAccess, catalogClock)

  const commercialAccess = new CommercialAccessService({
    session: repositories.sessionMetadata,
    licenseMetadata: repositories.licenseMetadata,
    permissions: repositories.bootstrapSnapshot,
    settings: repositories.appSettings,
    devices: repositories.deviceRegistration,
    company: repositories.bootstrapSnapshot,
    features: repositories.bootstrapSnapshot,
    connectivity: {
      getSnapshot: () => ({
        status: 'online',
        networkAvailable: true,
        backendReachable: true,
        checkedAt: '2026-01-01T02:00:00Z',
        lastBackendReachableAt: '2026-01-01T02:00:00Z',
        reason: 'probe_succeeded'
      })
    },
    now: () => new Date('2026-01-01T02:00:00.000Z')
  })

  const checkoutPreview = new CheckoutPreviewService({
    commercialAccess,
    permissions: repositories.bootstrapSnapshot,
    shiftAuthority: authority,
    catalog
  })

  return { checkoutPreview, authority }
}

const BUSINESS_TABLES = [
  'catalog_products',
  'catalog_categories',
  'catalog_product_barcodes',
  'catalog_stock_items',
  'payment_methods',
  'customers',
  'sync_queue'
]

databaseTest(
  'a successful checkout preview leaves every business table byte-identical',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { checkoutPreview } = setUpAuthorizedContext(database, repositories)

    const before = BUSINESS_TABLES.map((table) => tableDigest(sandbox, table))
    const outcome = checkoutPreview.validate(validIntent())
    const after = BUSINESS_TABLES.map((table) => tableDigest(sandbox, table))

    equal(outcome.outcome, 'valid')
    deepEqual(after, before)
    deepEqual(
      readCommitted<{ name: string }>(
        sandbox,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkout_previews', 'invoices', 'payments', 'outbox')"
      ),
      []
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a rejected checkout preview also leaves every business table byte-identical',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { checkoutPreview } = setUpAuthorizedContext(database, repositories)

    const before = BUSINESS_TABLES.map((table) => tableDigest(sandbox, table))
    const outcome = checkoutPreview.validate(
      validIntent({
        payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 600, reference: null }]
      })
    )
    const after = BUSINESS_TABLES.map((table) => tableDigest(sandbox, table))

    deepEqual(outcome, {
      outcome: 'invalid',
      code: 'PAYMENT_INSUFFICIENT_TENDER',
      field: 'payments',
      draftRevision: 1
    })
    deepEqual(after, before)
    closeDatabase(database)
  }
)

databaseTest('a checkout preview never mutates the shift it reads authority from', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { checkoutPreview } = setUpAuthorizedContext(database, repositories)

  const before = tableDigest(sandbox, 'shift_observation')
  checkoutPreview.validate(validIntent())
  const after = tableDigest(sandbox, 'shift_observation')

  equal(after, before)
  closeDatabase(database)
})

databaseTest(
  'a checkout preview denies selling once the shift closes on another terminal',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    const { checkoutPreview, authority } = setUpAuthorizedContext(database, repositories)

    equal(checkoutPreview.validate(validIntent()).outcome, 'valid')

    const context = authority.captureContext()
    repositories.shiftObservations.write({
      kind: 'shift',
      ...context,
      shiftUuid,
      status: 'closed',
      openedAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T03:00:00.000Z',
      source: 'close'
    })

    deepEqual(checkoutPreview.validate(validIntent()), {
      outcome: 'shift-unavailable',
      state: 'closed'
    })
    closeDatabase(database)
  }
)

databaseTest('a checkout preview requests a refresh when the catalog is republished', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { checkoutPreview } = setUpAuthorizedContext(database, repositories)

  const outcome = checkoutPreview.validate(validIntent({ catalogRevision: 'f'.repeat(64) }))
  deepEqual(outcome, { outcome: 'refresh-required', draftRevision: 1 })
  closeDatabase(database)
})
