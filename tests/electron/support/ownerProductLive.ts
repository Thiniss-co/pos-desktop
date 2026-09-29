import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { AllocationAcquisitionService } from '../../../src/main/services/allocationAcquisition.service'
import { AllocationDispatchReconciler } from '../../../src/main/services/allocationDispatchReconciler.service'
import { BootstrapService } from '../../../src/main/services/bootstrap.service'
import { CatalogReadAccessService } from '../../../src/main/services/catalogReadAccess.service'
import { CatalogService } from '../../../src/main/services/catalog.service'
import { CatalogTrustedClockService } from '../../../src/main/services/catalogTrustedClock.service'
import { CommercialAccessService } from '../../../src/main/services/commercialAccess.service'
import { LicenseService } from '../../../src/main/services/license.service'
import { LocalSaleService } from '../../../src/main/services/localSale.service'
import { SaleCompletionService } from '../../../src/main/services/saleCompletion.service'
import { SessionService } from '../../../src/main/services/session.service'
import { ShiftAuthorityService } from '../../../src/main/services/shiftAuthority.service'
import { StockAllocationService } from '../../../src/main/services/stockAllocation.service'
import { InvoiceUploadOutcomeRecorder } from '../../../src/main/sync/invoiceUploadOutcome'
import { InvoiceUploadWorker } from '../../../src/main/sync/invoiceUploadWorker'
import { uploadInvoice } from '../../../src/main/sync/invoiceUpload.client'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import type { ConnectivitySnapshot } from '../../../src/shared/contracts/connectivity.contract'
import type { OwnerProductLiveContext } from './liveUploadBackend'
import type { RealRepositories } from './realRepositories'
import { createUploadTransportSpy, type UploadTransportSpy } from './uploadTransportSpy'

/**
 * POS reliability rev 3 — the production main-process composition for the owner-product live
 * gate, against the real Laravel server the CP-3G-5 harness started.
 *
 * It mirrors the production wiring of the sale path (session, shift authority, commercial access,
 * catalog, license validation, bootstrap install, local sale, allocation acquisition with durable
 * dispatch evidence, the dispatch reconciler and the invoice upload worker) with REAL repositories
 * and the REAL `DesktopApiClient`. Only two things are substituted:
 *  - the transport `fetch` is wrapped by `UploadTransportSpy`, which always lets the request reach
 *    the real server first and only then decides what the caller observes (lost answer);
 *  - connectivity is a switch the scenario controls, because "offline" here means "main believes it
 *    is offline", which is exactly the state the production connectivity monitor would publish.
 */
export interface OwnerProductHarness {
  readonly repositories: RealRepositories
  readonly spy: UploadTransportSpy
  readonly license: LicenseService
  readonly bootstrap: BootstrapService
  readonly catalog: CatalogService
  readonly localSale: LocalSaleService
  readonly completion: SaleCompletionService
  readonly reconciler: AllocationDispatchReconciler
  readonly uploads: InvoiceUploadWorker
  setOnline(online: boolean): void
  /** The installed catalog revision, read the way the renderer's cart would freeze it. */
  installedRevision(): string
  stop(): void
}

function snapshot(online: boolean): ConnectivitySnapshot {
  const now = new Date().toISOString()
  return {
    status: online ? 'online' : 'offline',
    networkAvailable: online,
    backendReachable: online,
    checkedAt: now,
    lastBackendReachableAt: online ? now : null,
    reason: online ? 'probe_succeeded' : 'probe_connection_failed'
  } as ConnectivitySnapshot
}

/**
 * @param startSession false on a simulated restart: the relaunched app reuses the session, shift
 *   observation and device identity already on disk instead of minting new ones.
 */
export function buildOwnerProductHarness(params: {
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly context: OwnerProductLiveContext
  readonly origin: string
  readonly startSession: boolean
  readonly spy?: UploadTransportSpy
}): OwnerProductHarness {
  const { database, repositories, context } = params
  const spy = params.spy ?? createUploadTransportSpy()
  let online = true
  const connectivity = { getSnapshot: () => snapshot(online) }

  if (params.startSession) {
    if (!repositories.deviceIdentity.get()) {
      repositories.deviceIdentity.create({
        deviceUuid: context.device_uuid,
        deviceName: 'Owner-product live register',
        platform: 'linux',
        osVersion: '6.0',
        appVersion: '1.0.0',
        isRegistered: true
      })
    }
    repositories.deviceIdentity.markRegisteredWithBackend(new Date().toISOString())
    repositories.deviceRegistration.set({
      serverDeviceId: context.server_device_id,
      status: 'active',
      lastSeenAt: null,
      updatedAt: new Date().toISOString()
    })
  }

  const apiClient = new DesktopApiClient({
    apiOrigin: new URL(params.origin),
    getAccessToken: () => context.token,
    getDeviceUuid: () => context.device_uuid,
    fetchImplementation: spy.fetchImplementation,
    timeoutMs: 20_000
  })

  const session = new SessionService(
    repositories.sessionMetadata,
    { deleteSecret: () => undefined },
    { database, epoch: repositories.sessionEpoch, observations: repositories.shiftObservations }
  )
  if (params.startSession) {
    session.startSession({
      userName: 'Desktop MVP Admin',
      userEmail: 'admin@desktop-mvp.test',
      userUuid: context.user_uuid,
      userIsActive: true,
      companyUuid: context.company_uuid,
      deviceUuid: context.device_uuid,
      serverDeviceId: context.server_device_id
    })
  }

  const commercialAccess = new CommercialAccessService({
    session: repositories.sessionMetadata,
    licenseMetadata: repositories.licenseMetadata,
    permissions: repositories.bootstrapSnapshot,
    settings: repositories.appSettings,
    devices: repositories.deviceRegistration,
    company: repositories.bootstrapSnapshot,
    features: repositories.bootstrapSnapshot,
    connectivity
  })
  // The license JWT is a credential; this gate never persists it (production keeps it in the
  // OS-secured store, which the Electron test process does not have).
  const license = new LicenseService(apiClient, repositories.licenseMetadata, {
    setSecret: () => undefined
  })
  const catalogReadAccess = new CatalogReadAccessService({
    identity: repositories.deviceIdentity,
    deviceRegistration: repositories.deviceRegistration,
    session: repositories.sessionMetadata,
    secrets: { getSecret: () => context.token },
    company: repositories.bootstrapSnapshot,
    permissions: repositories.bootstrapSnapshot
  })
  const catalogClock = new CatalogTrustedClockService(repositories.appSettings)
  const catalog = new CatalogService(
    repositories.catalog,
    catalogReadAccess,
    catalogClock,
    repositories.stockAllocations
  )
  const bootstrap = new BootstrapService(
    apiClient,
    repositories.deviceIdentity,
    commercialAccess,
    repositories.bootstrapSnapshot,
    (result) => {
      if (result.catalogRevision) {
        catalog.markPublished(result.catalogRevision)
      }
    },
    undefined,
    repositories.sessionMetadata
  )

  const shiftAuthority = new ShiftAuthorityService({
    observations: repositories.shiftObservations,
    session: repositories.sessionMetadata,
    company: repositories.bootstrapSnapshot,
    device: {
      getOrCreate: () => {
        const identity = repositories.deviceIdentity.get()
        if (!identity) {
          throw new Error('The live register identity is unavailable')
        }
        return identity
      }
    },
    epoch: repositories.sessionEpoch
  })

  const allocationService = new StockAllocationService(repositories.stockAllocations)
  const localSale = new LocalSaleService({
    database,
    saleAttempts: repositories.saleAttempts,
    allocationDispatches: repositories.allocationDispatches,
    localSale: repositories.localSale,
    localStock: repositories.localStock,
    stockAllocations: repositories.stockAllocations,
    allocationService,
    commercialAccess,
    permissions: repositories.bootstrapSnapshot,
    shiftAuthority,
    bootstrapSnapshot: repositories.bootstrapSnapshot,
    catalog,
    connectivity,
    syncQueue: repositories.syncQueue,
    offlineSaleAuthorities: repositories.offlineSaleAuthorities
  })
  const acquisition = new AllocationAcquisitionService({
    database,
    apiClient,
    stockAllocations: repositories.stockAllocations,
    allocationService,
    allocationReconciliation: repositories.allocationReconciliation,
    connectivity,
    allocationDispatches: repositories.allocationDispatches
  })
  const reconciler = new AllocationDispatchReconciler({
    dispatches: repositories.allocationDispatches,
    acquisition,
    connectivity,
    apiClient,
    owner: () => ({ companyUuid: context.company_uuid, deviceUuid: context.device_uuid }),
    allocationCapabilitySupported: () =>
      repositories.stockAllocations.getCapability()?.state === 'supported',
    // No timers in a gate: every run is requested explicitly and awaited.
    schedule: () => ({ clear: () => undefined })
  })
  const uploads = new InvoiceUploadWorker({
    syncQueue: repositories.syncQueue,
    recorder: new InvoiceUploadOutcomeRecorder({
      database,
      syncQueue: repositories.syncQueue,
      localSale: repositories.localSale,
      syncConflicts: repositories.syncConflicts,
      allocationReconciliation: repositories.allocationReconciliation
    }),
    commercialAccess,
    permissions: repositories.bootstrapSnapshot,
    session: repositories.sessionMetadata,
    upload: (payloadJson) => uploadInvoice(apiClient, payloadJson),
    schedule: () => () => undefined
  })
  const completion = new SaleCompletionService({ localSale, acquisition })

  return {
    repositories,
    spy,
    license,
    bootstrap,
    catalog,
    localSale,
    completion,
    reconciler,
    uploads,
    setOnline: (value) => {
      online = value
    },
    installedRevision: () => {
      const revision = repositories.catalog.getContract()?.revision
      if (!revision) {
        throw new Error('No catalog contract is installed')
      }
      return revision
    },
    stop: () => {
      reconciler.stop()
      uploads.shutdown()
    }
  }
}

/**
 * Records the open server shift for the CURRENT session context, exactly as `shifts.current()`
 * does after login. Called once per desktop database, after the first bootstrap installed the
 * company/branch/warehouse the shift authority binds to.
 */
export function observeOpenShift(
  repositories: RealRepositories,
  context: OwnerProductLiveContext
): void {
  const authority = new ShiftAuthorityService({
    observations: repositories.shiftObservations,
    session: repositories.sessionMetadata,
    company: repositories.bootstrapSnapshot,
    device: {
      getOrCreate: () => {
        const identity = repositories.deviceIdentity.get()
        if (!identity) {
          throw new Error('The live register identity is unavailable')
        }
        return identity
      }
    },
    epoch: repositories.sessionEpoch
  })
  const observedAt = new Date().toISOString()
  repositories.shiftObservations.write({
    kind: 'shift',
    ...authority.captureContext(),
    shiftUuid: context.shift_uuid,
    status: 'open',
    openedAt: observedAt,
    observedAt,
    source: 'current'
  })
}

/** One cash sale of `quantity` units of one product, paid exactly (owner products are untaxed). */
export function cashIntent(params: {
  readonly catalogRevision: string
  readonly productUuid: string
  readonly quantity: number
  readonly unitPriceAmount: number
  readonly paymentMethodUuid: string
}): CheckoutIntent {
  return {
    draftRevision: 1,
    catalogRevision: params.catalogRevision,
    items: [
      {
        id: 'line-1',
        productUuid: params.productUuid,
        quantity: `${params.quantity}.000`,
        discountType: null,
        discountValue: 0
      }
    ],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [
      {
        id: 'payment-1',
        paymentMethodUuid: params.paymentMethodUuid,
        amount: params.unitPriceAmount * params.quantity,
        reference: null
      }
    ]
  }
}

// The runner bundles this file into a temporary directory, so `__dirname` is not the source tree;
// every Electron suite (and the CP-3G-5 harness) runs with the desktop root as its working directory.
const DESKTOP_ROOT = resolve(process.cwd())
const GUI_FIXTURE = join(DESKTOP_ROOT, 'tests', 'electron', 'support', 'sandbox', 'guiFixture.php')

/**
 * Runs one owner/inventory operation on the live backend through the existing guarded fixture
 * script (`guiFixture.php` → `laravelSandboxGuard.php`), which re-verifies in the writing process
 * that Laravel resolved exactly the harness's disposable SQLite file before any write.
 *
 * The child environment is built from scratch — never `...process.env` — so nothing ambient can
 * redirect the connection.
 */
export function fixtureOp(
  context: OwnerProductLiveContext,
  operation: string,
  argument?: string
): Record<string, unknown> {
  const databasePath = process.env.CP3G5_BACKEND_DB
  if (!databasePath) {
    throw new Error('CP3G5_BACKEND_DB is required for a live fixture operation')
  }
  const result = spawnSync(
    'php',
    [GUI_FIXTURE, context.backend_root, operation, ...(argument ? [argument] : [])],
    {
      cwd: context.backend_root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        APP_ENV: 'testing',
        APP_DEBUG: 'false',
        DB_CONNECTION: 'sqlite',
        DB_DATABASE: databasePath,
        DB_URL: '',
        DB_FOREIGN_KEYS: 'true',
        POS_SANDBOX_EXPECTED_DB: databasePath,
        // The harness's own never-written cache path, next to the disposable database.
        APP_CONFIG_CACHE: join(dirname(databasePath), 'laravel-config-cache.php'),
        LOG_CHANNEL: 'errorlog',
        SESSION_DRIVER: 'array',
        CACHE_STORE: 'array',
        QUEUE_CONNECTION: 'sync',
        POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED: 'true',
        STOCK_ALLOCATION_PREPARATION_ENABLED: 'true'
      },
      encoding: 'utf8'
    }
  )
  if (result.status !== 0) {
    // Only the guard's own one-line refusal is surfaced; Laravel output is not echoed.
    const refusal = /sandbox guard refused: [^\n]*/.exec(result.stderr ?? '')?.[0]
    throw new Error(
      `live fixture operation ${operation} failed (${result.status}) ${refusal ?? ''}`
    )
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Writes one scenario's sanitized evidence when `OWNER_PRODUCT_LIVE_EVIDENCE_DIR` is set. The
 * harness discards suite output by design, so this is how a run proves which scenarios executed
 * and what they observed. Callers pass facts only: counts, states, codes, hashes and uuids —
 * never a token, a request header, an absolute path or a payload body.
 */
export function writeScenarioEvidence(name: string, facts: Record<string, unknown>): void {
  const directory = process.env.OWNER_PRODUCT_LIVE_EVIDENCE_DIR
  if (!directory) {
    return
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify({ scenario: name, recordedAt: new Date().toISOString(), ...facts }, null, 2)}\n`
  )
}
