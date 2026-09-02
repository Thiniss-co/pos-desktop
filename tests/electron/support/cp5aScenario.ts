// Phase 3F CP-5a (plan §6.4): the one deterministic scenario shared by the fixture generator
// (`scripts/generateCp5aArtifact.ts`) and its drift-detection test
// (`tests/electron/suites/cp5aArtifact.suite.ts`). Both call `buildCp5aArtifact()` — never two
// independent implementations of "the same" sale — so the test proves the on-disk fixture is a
// byte-identical, freshly-reproducible commit, not merely internally self-consistent.
import { createHash } from 'node:crypto'
import { closeDatabase } from '../../../src/main/database/connection'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { CatalogReadAccessService } from '../../../src/main/services/catalogReadAccess.service'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogTrustedClockService } from '../../../src/main/services/catalogTrustedClock.service'
import { CommercialAccessService } from '../../../src/main/services/commercialAccess.service'
import { LocalSaleService } from '../../../src/main/services/localSale.service'
import { SessionService } from '../../../src/main/services/session.service'
import { ShiftAuthorityService } from '../../../src/main/services/shiftAuthority.service'
import { StockAllocationService } from '../../../src/main/services/stockAllocation.service'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import type { DatabaseSandbox } from './sandbox'
import { openTestDatabase } from './openTestDatabase'
import { realRepositories } from './realRepositories'

export const CP5A_SCHEMA_VERSION = 1
export const CP5A_EMITTING_SUITE = 'tests/electron/suites/cp5aArtifact.suite.ts'

const companyUuid = '11111111-1111-4111-8111-111111111111'
const serverDeviceId = '22222222-2222-4222-8222-222222222222'
const deviceUuid = '33333333-3333-4333-8333-333333333333'
const userUuid = '44444444-4444-4444-8444-444444444444'
const branchUuid = '77777777-7777-4777-8777-777777777777'
const warehouseUuid = '88888888-8888-4888-8888-888888888888'
const trackedProductUuid = '66666666-6666-4666-8666-666666666666'
const methodUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const shiftUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const allocationUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const attemptKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const FIXED_NOW = new Date('2026-01-01T02:00:00.000Z')

/**
 * `namespace` keeps this deterministic sequence visibly distinct from any other one used in the
 * same scenario (`LocalSaleService.createUuid` and `StockAllocationService.createUuid` are two
 * independent counters) — without it, two counters that each start at 1 collide on their first
 * value, producing a fixture where an invoice's own uuid and an unrelated allocation-consumption's
 * uuid are coincidentally identical, which is confusing at best and could mask a real mix-up.
 */
function fixedUuidSequence(namespace: number): () => string {
  let counter = 0
  return () => `9999999${namespace}-9999-4999-8999-${(++counter).toString().padStart(12, '0')}`
}

function bootstrapResource(): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()
  const [baseProduct] = source.products ?? []
  if (!baseProduct) {
    throw new Error('CP-5a scenario requires the default bootstrap product fixture')
  }

  return desktopBootstrapFixture({
    permissions: ['pos.view', 'pos.sell'],
    branch: { id: branchUuid, name: 'Main Branch', is_active: true },
    warehouse: { id: warehouseUuid, name: 'Main Warehouse', is_active: true },
    products: [
      {
        ...baseProduct,
        uuid: trackedProductUuid,
        track_stock: true,
        resolved_price: baseProduct.resolved_price
          ? { ...baseProduct.resolved_price, amount: 500 }
          : null,
        resolved_tax: { id: null, mode: 'none', rate_basis_points: 0, revision: 'c'.repeat(64) }
      }
    ],
    product_barcodes: [],
    stock_items: [
      {
        id: '99999999-9999-4999-8999-999999999998',
        product_uuid: trackedProductUuid,
        warehouse_uuid: warehouseUuid,
        quantity: 100,
        reserved_quantity: 0,
        allocation_reserved_quantity: 0,
        available_quantity: 100,
        minimum_quantity: null,
        maximum_quantity: null,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
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

function intent(): CheckoutIntent {
  return {
    draftRevision: 1,
    catalogRevision: bootstrapResource().catalog_contract.revision,
    items: [
      {
        id: 'item-1',
        productUuid: trackedProductUuid,
        quantity: '2.000',
        discountType: null,
        discountValue: 0
      }
    ],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 1000, reference: null }]
  }
}

export interface Cp5aFixtureContext {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly branchUuid: string
  readonly warehouseUuid: string
  readonly shiftUuid: string
  readonly product: {
    readonly uuid: string
    readonly name: string
    readonly trackStock: true
    readonly unitPriceAmount: number
    readonly currency: string
  }
  readonly paymentMethod: {
    readonly uuid: string
    readonly name: string
    readonly type: 'cash'
    readonly requiresReference: false
  }
  readonly allocation: {
    readonly allocationUuid: string
    readonly grantedQuantityMilli: number
    readonly lifecycleGeneration: number
  }
}

export interface Cp5aArtifactPayload {
  readonly fixtureContext: Cp5aFixtureContext
  readonly payload: Record<string, unknown>
}

/**
 * Runs the one deterministic CP-5a sale to completion against the given disposable sandbox and
 * returns the *actual, immutable* `sync_queue.payload_json` it produced — never a separately
 * reconstructed approximation of it — plus the fixture context a backend seed needs to match it.
 * Opens and closes its own database on `sandbox`; the caller owns the sandbox itself (creation and
 * disposal), matching every other suite's `databaseTest`/`createSandbox` convention.
 */
export function buildCp5aArtifact(sandbox: DatabaseSandbox): Cp5aArtifactPayload {
  let database: SqliteDatabase | null = null

  try {
    database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)

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
            throw new Error('CP-5a scenario device identity is unavailable')
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
    const catalogClock = new CatalogTrustedClockService(repositories.appSettings, () => FIXED_NOW)
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
      now: () => FIXED_NOW
    })

    repositories.stockAllocations.upsertGrant({
      allocationUuid,
      contractVersion: 1,
      companyUuid,
      deviceUuid,
      warehouseUuid,
      productUuid: trackedProductUuid,
      serverSequence: 1,
      lifecycleGeneration: 1,
      grantedQuantityMilli: 5000,
      consumeUntil: '2027-01-01T00:00:00.000Z',
      envelopeHash: 'f'.repeat(64),
      receivedAt: '2026-01-01T00:00:00.000Z'
    })

    const allocationService = new StockAllocationService(
      repositories.stockAllocations,
      fixedUuidSequence(1)
    )
    const localSale = new LocalSaleService({
      database,
      saleAttempts: repositories.saleAttempts,
      localSale: repositories.localSale,
      localStock: repositories.localStock,
      stockAllocations: repositories.stockAllocations,
      allocationService,
      commercialAccess,
      permissions: repositories.bootstrapSnapshot,
      shiftAuthority: authority,
      bootstrapSnapshot: repositories.bootstrapSnapshot,
      catalog,
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
      syncQueue: repositories.syncQueue,
      now: () => FIXED_NOW,
      createUuid: fixedUuidSequence(2)
    })

    const outcome = localSale.complete(attemptKey, intent())
    if (outcome.outcome !== 'committed') {
      throw new Error(
        `CP-5a scenario did not commit — outcome was ${JSON.stringify(outcome)}. The fixture ` +
          'was not regenerated; investigate before trusting the on-disk artifact.'
      )
    }

    const row = database
      .prepare(
        `SELECT payload_json FROM sync_queue WHERE local_aggregate_uuid = ? AND aggregate_type = 'invoice'`
      )
      .get(outcome.invoice.localUuid) as { payload_json: string } | undefined

    if (!row) {
      throw new Error('CP-5a scenario committed but produced no sync_queue row to export')
    }

    return {
      fixtureContext: {
        companyUuid,
        deviceUuid,
        branchUuid,
        warehouseUuid,
        shiftUuid,
        product: {
          uuid: trackedProductUuid,
          name: 'Sparkling Water',
          trackStock: true,
          unitPriceAmount: 500,
          currency: 'EGP'
        },
        paymentMethod: {
          uuid: methodUuid,
          name: 'Cash',
          type: 'cash',
          requiresReference: false
        },
        allocation: {
          allocationUuid,
          grantedQuantityMilli: 5000,
          lifecycleGeneration: 1
        }
      },
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    }
  } finally {
    if (database) {
      closeDatabase(database)
    }
  }
}

/** Mirrors `verifyFixtureParity.mjs`'s `canonicalize`: sort object keys recursively, keep array order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }

  return value
}

export function cp5aArtifactHash(fixtureContext: Cp5aFixtureContext, payload: unknown): string {
  const canonical = canonicalize({
    schemaVersion: CP5A_SCHEMA_VERSION,
    emittingSuite: CP5A_EMITTING_SUITE,
    fixtureContext,
    payload
  })

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
