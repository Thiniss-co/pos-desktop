/**
 * The shared Phase 3F local-sale fixture: one authorized company/device/cashier/shift/branch/
 * warehouse context, an untracked and a tracked product, one cash method, and a real
 * `LocalSaleService` built from `realRepositories()` only.
 *
 * Extracted from `localSaleCompletion.suite.ts` at CP-5b so the completion, attempts, concurrency,
 * and fresh-process recovery suites — and the recovery worker processes those spawn — all build
 * byte-identically the same on-disk state through the same production code path. Duplicating it
 * per suite would let the suites silently drift apart.
 */

import type { SqliteDatabase } from '../../../src/main/database/connection'
import { desktopBootstrapFixture } from '../../../src/main/testing/fixtures/desktopBootstrap.fixture'
import { licenseStatusFixture } from '../../../src/main/testing/fixtures/licenseStatus.fixture'
import { CatalogReadAccessService } from '../../../src/main/services/catalogReadAccess.service'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogTrustedClockService } from '../../../src/main/services/catalogTrustedClock.service'
import { CommercialAccessService } from '../../../src/main/services/commercialAccess.service'
import {
  originContextFingerprint,
  semanticIntentFingerprint
} from '../../../src/main/services/localSale.fingerprint'
import { LocalSaleService } from '../../../src/main/services/localSale.service'
import { SessionService } from '../../../src/main/services/session.service'
import { ShiftAuthorityService } from '../../../src/main/services/shiftAuthority.service'
import { StockAllocationService } from '../../../src/main/services/stockAllocation.service'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import { realRepositories, type RealRepositories } from './realRepositories'

export const companyUuid = '11111111-1111-4111-8111-111111111111'
export const serverDeviceId = '22222222-2222-4222-8222-222222222222'
export const deviceUuid = '33333333-3333-4333-8333-333333333333'
export const userUuid = '44444444-4444-4444-8444-444444444444'
export const productUuid = '55555555-5555-4555-8555-555555555555'
export const trackedProductUuid = '66666666-6666-4666-8666-666666666666'
export const methodUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const shiftUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
export const branchUuid = '77777777-7777-4777-8777-777777777777'
export const warehouseUuid = '88888888-8888-4888-8888-888888888888'

/**
 * @param overrides applied last, so a suite can vary the granted permissions (the D1-A rights
 *   matrix) without rebuilding the whole catalogue.
 */
export function bootstrapResource(
  overrides: Partial<ReturnType<typeof desktopBootstrapFixture>> = {}
): ReturnType<typeof desktopBootstrapFixture> {
  const source = desktopBootstrapFixture()
  const [baseProduct] = source.products ?? []

  return desktopBootstrapFixture({
    permissions: ['pos.view', 'pos.sell'],
    branch: { id: branchUuid, name: 'Main Branch', is_active: true },
    warehouse: { id: warehouseUuid, name: 'Main Warehouse', is_active: true },
    products: [
      {
        ...baseProduct,
        track_stock: false,
        resolved_price: baseProduct.resolved_price
          ? { ...baseProduct.resolved_price, amount: 1000 }
          : null,
        resolved_tax: { id: null, mode: 'none', rate_basis_points: 0, revision: 'c'.repeat(64) }
      },
      {
        ...baseProduct,
        uuid: trackedProductUuid,
        track_stock: true,
        barcode: null,
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
    ],
    ...overrides
  })
}

export function validIntent(overrides: Partial<CheckoutIntent> = {}): CheckoutIntent {
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

export interface AuthorizedFixture {
  readonly localSale: LocalSaleService
  readonly authority: ShiftAuthorityService
  readonly session: SessionService
  /**
   * Rebuilds a `LocalSaleService` sharing this fixture's already-committed session/shift/catalog
   * state, but with its write-side repositories and `database.transaction()` bound to
   * `writeDatabase` — used by the fault-injection tests below so the injected failure counter
   * starts fresh at the beginning of `complete()`/`retry()`, never during setup (setup itself
   * writes through the *real* connection first, exactly like the existing
   * `bootstrapSnapshot.suite.ts` fault-injection pattern).
   */
  withWriteDatabase(writeDatabase: SqliteDatabase): LocalSaleService
}

export function setUpAuthorizedContext(
  database: SqliteDatabase,
  repositories: RealRepositories,
  now: () => Date = () => new Date('2026-01-01T02:00:00.000Z'),
  connectivityStatus: 'online' | 'offline' = 'online',
  startNewSession = true
): AuthorizedFixture {
  // Guarded so a *second* process opening the same sandbox database rebuilds the same context
  // instead of colliding on the singleton identity row — a relaunched app reuses the device
  // identity already on disk, it never re-creates one.
  if (!repositories.deviceIdentity.get()) {
    repositories.deviceIdentity.create({
      deviceUuid,
      deviceName: 'Example Register',
      platform: 'linux',
      osVersion: '6.0',
      appVersion: '1.0.0',
      isRegistered: true
    })
  }
  repositories.deviceIdentity.markRegisteredWithBackend('2026-01-01T00:00:00Z')
  repositories.deviceRegistration.set({
    serverDeviceId,
    status: 'active',
    lastSeenAt: null,
    updatedAt: '2026-01-01T00:00:00Z'
  })
  // A fresh process reopening an already prepared test database preserves its exact catalog and
  // allocation snapshot; startup does not fabricate a replacement bootstrap response.
  if (!repositories.catalog.getContract()) {
    repositories.bootstrapSnapshot.persistSnapshot(bootstrapResource(), '2026-01-01T00:01:00+00:00')
  }
  repositories.licenseMetadata.setValidatedStatus(licenseStatusFixture(), '2026-01-01T00:00:00Z')

  const session = new SessionService(
    repositories.sessionMetadata,
    { deleteSecret: () => undefined },
    { database, epoch: repositories.sessionEpoch, observations: repositories.shiftObservations }
  )
  if (startNewSession) {
    session.startSession({
      userName: 'Cashier',
      userEmail: 'cashier@example.test',
      userUuid,
      userIsActive: true,
      companyUuid,
      deviceUuid,
      serverDeviceId
    })
  }

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
  const catalogClock = new CatalogTrustedClockService(repositories.appSettings, now)
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
        status: connectivityStatus,
        networkAvailable: connectivityStatus === 'online',
        backendReachable: connectivityStatus === 'online',
        checkedAt: '2026-01-01T02:00:00Z',
        lastBackendReachableAt: '2026-01-01T02:00:00Z',
        reason: 'probe_succeeded'
      })
    },
    now
  })

  function buildLocalSale(writeDatabase: SqliteDatabase): LocalSaleService {
    const writeRepositories =
      writeDatabase === database ? repositories : realRepositories(writeDatabase)
    // Deterministic *and* unique: a cart may split one line across grants, or hold two lines of the
    // same tracked product, and every local consumption row needs its own primary key.
    let allocationConsumptionCount = 0
    const allocationService = new StockAllocationService(writeRepositories.stockAllocations, () => {
      allocationConsumptionCount += 1
      return `99999992-9999-4999-8999-${allocationConsumptionCount.toString().padStart(12, '0')}`
    })

    return new LocalSaleService({
      database: writeDatabase,
      saleAttempts: writeRepositories.saleAttempts,
      localSale: writeRepositories.localSale,
      localStock: writeRepositories.localStock,
      stockAllocations: writeRepositories.stockAllocations,
      allocationService,
      commercialAccess,
      permissions: repositories.bootstrapSnapshot,
      shiftAuthority: authority,
      bootstrapSnapshot: repositories.bootstrapSnapshot,
      catalog,
      connectivity: {
        getSnapshot: () => ({
          status: connectivityStatus,
          networkAvailable: connectivityStatus === 'online',
          backendReachable: connectivityStatus === 'online',
          checkedAt: '2026-01-01T02:00:00Z',
          lastBackendReachableAt: '2026-01-01T02:00:00Z',
          reason: 'probe_succeeded'
        })
      },
      syncQueue: writeRepositories.syncQueue,
      now
    })
  }

  return {
    localSale: buildLocalSale(database),
    authority,
    session,
    withWriteDatabase: buildLocalSale
  }
}

/**
 * Manufactures a genuinely `claimed`, never-committed row directly through the repository —
 * exactly the durable shape a real crash between T1 (claim) and the business commit leaves on
 * disk (plan §1.7/"Crash boundaries"). `failingDatabase` mid-transaction injection is a *caught*
 * exception (a real crash is not caught by anything), so it is unsuitable for this shape; it is
 * used elsewhere in this suite to prove the distinct "constraint/invariant" rejection path.
 */
export function claimStuckAttempt(
  repositories: RealRepositories,
  authority: ShiftAuthorityService,
  attemptKey: string,
  intent: CheckoutIntent
): void {
  const context = authority.captureContext()
  const branch = repositories.bootstrapSnapshot.getBranch()
  const warehouse = repositories.bootstrapSnapshot.getWarehouse()
  if (!branch || !warehouse) {
    throw new Error('Test fixture is missing branch/warehouse')
  }
  const shift = authority.resolveForSell()
  if (shift.kind !== 'open') {
    throw new Error('Test fixture has no open shift')
  }

  const originContext = {
    companyUuid: context.companyUuid,
    deviceUuid: context.deviceUuid,
    userUuid: context.userUuid,
    originShiftUuid: shift.shiftUuid,
    originShiftObservedAt: shift.observedAt,
    originBranchUuid: branch.branchUuid,
    originWarehouseUuid: warehouse.warehouseUuid
  }
  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: context.companyUuid,
    deviceUuid: context.deviceUuid,
    userUuid: context.userUuid,
    claimSessionEpoch: context.sessionEpoch,
    originShiftUuid: shift.shiftUuid,
    originShiftObservedAt: shift.observedAt,
    originBranchUuid: branch.branchUuid,
    originWarehouseUuid: warehouse.warehouseUuid,
    originContextFingerprint: originContextFingerprint(originContext),
    intentFingerprint: semanticIntentFingerprint({
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid,
      userUuid: context.userUuid,
      catalogRevision: intent.catalogRevision,
      customerUuid: intent.customerUuid,
      items: intent.items.map((item) => ({
        productUuid: item.productUuid,
        quantity: item.quantity,
        discountType: item.discountType,
        discountValue: item.discountValue
      })),
      invoiceDiscountType: intent.invoiceDiscount.discountType,
      invoiceDiscountValue: intent.invoiceDiscount.discountValue,
      payments: intent.payments.map((payment) => ({
        paymentMethodUuid: payment.paymentMethodUuid,
        amount: payment.amount,
        reference: payment.reference
      })),
      notes: null
    }),
    intentVersion: 1,
    intentJson: JSON.stringify(intent)
  })
}
