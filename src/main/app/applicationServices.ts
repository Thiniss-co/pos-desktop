import { app, net, powerMonitor, safeStorage } from 'electron'
import { hostname, platform, release } from 'os'
import { runtimeInfoSchema, type RuntimeInfo } from '@shared/contracts/system.contract'
import { loadRuntimeConfig, type RuntimeConfig } from '../config/runtimeConfig'
import { closeDatabase, openDatabase, type SqliteDatabase } from '../database/connection'
import { databaseMigrations } from '../database/migrations'
import { runMigrations } from '../database/migrator'
import { DesktopApiClient } from '../http/desktopApiClient'
import { AppSettingsRepository } from '../repositories/appSettings.repository'
import { BootstrapStateRepository } from '../repositories/bootstrapState.repository'
import { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import { CatalogRepository } from '../repositories/catalog.repository'
import { SqliteDeviceIdentityRepository } from '../repositories/deviceIdentity.repository'
import { DeviceRegistrationRepository } from '../repositories/deviceRegistration.repository'
import { LicenseMetadataRepository } from '../repositories/licenseMetadata.repository'
import { LocalSaleRepository } from '../repositories/localSale.repository'
import { LocalStockRepository } from '../repositories/localStock.repository'
import { SaleAttemptRepository } from '../repositories/saleAttempt.repository'
import { SecureSecretsRepository } from '../repositories/secureSecrets.repository'
import { SessionEpochRepository } from '../repositories/sessionEpoch.repository'
import { SqliteSessionMetadataRepository } from '../repositories/sessionMetadata.repository'
import { ShiftObservationRepository } from '../repositories/shiftObservation.repository'
import { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import { AllocationRecoveryRepository } from '../repositories/allocationRecovery.repository'
import { SyncConflictRepository } from '../repositories/syncConflict.repository'
import { SyncQueueRepository } from '../repositories/syncQueue.repository'
import { InvoiceUploadFailureReader } from '../sync/invoiceUploadFailures'
import { subscribeInvoiceUploadTriggers } from '../sync/invoiceUploadTriggers'
import { InvoiceUploadOutcomeRecorder } from '../sync/invoiceUploadOutcome'
import { InvoiceUploadWorker } from '../sync/invoiceUploadWorker'
import { uploadInvoice } from '../sync/invoiceUpload.client'
import { ActivationService } from '../services/activation.service'
import { AllocationAcquisitionService } from '../services/allocationAcquisition.service'
import { AllocationReconciliationService } from '../services/allocationReconciliation.service'
import { AllocationRecoveryService } from '../services/allocationRecovery.service'
import { AuthService, DESKTOP_ACCESS_TOKEN_KEY } from '../services/auth.service'
import { BootstrapService } from '../services/bootstrap.service'
import { CatalogReadAccessService } from '../services/catalogReadAccess.service'
import { CatalogRefreshService } from '../services/catalogRefresh.service'
import { CatalogService } from '../services/catalog.service'
import { CatalogTrustedClockService } from '../services/catalogTrustedClock.service'
import type {
  PreparationCycleResult,
  PreparationReadiness
} from '@shared/contracts/preparation.contract'
import { PreparationRepository } from '../repositories/preparation.repository'
import { PreparationService } from '../services/preparation.service'
import { PreparationReadinessService } from '../services/preparationReadiness.service'
import { PreparationReconnectService } from '../services/preparationReconnect.service'
import { CheckoutPreviewService } from '../services/checkoutPreview.service'
import { CompanyUsersService } from '../services/companyUsers.service'
import { CommercialAccessService } from '../services/commercialAccess.service'
import { DeviceIdentityService } from '../services/deviceIdentity.service'
import { LicenseService } from '../services/license.service'
import { LocalSaleService } from '../services/localSale.service'
import { SaleCompletionService } from '../services/saleCompletion.service'
import { SecureStorageService } from '../services/secureStorage.service'
import { SessionService } from '../services/session.service'
import { ShiftAuthorityService } from '../services/shiftAuthority.service'
import { ShiftService } from '../services/shift.service'
import { ShiftPermissions } from '../services/shiftPermissions'
import { StockAllocationService } from '../services/stockAllocation.service'
import { ConnectivityService } from '../services/connectivity.service'
import { broadcastConnectivityChanged } from '../ipc/connectivity.ipc'
import { CommercialAccessPublisher } from '../ipc/license.ipc'
import { broadcastSyncChanged } from '../ipc/sync.ipc'

export interface ApplicationServices {
  readonly runtimeConfig: RuntimeConfig
  readonly database: SqliteDatabase
  readonly appSettings: AppSettingsRepository
  readonly deviceIdentity: DeviceIdentityService
  readonly deviceRegistration: DeviceRegistrationRepository
  readonly session: SessionService
  readonly licenseMetadata: LicenseMetadataRepository
  readonly bootstrapState: BootstrapStateRepository
  readonly syncQueue: SyncQueueRepository
  readonly syncConflicts: SyncConflictRepository
  readonly apiClient: DesktopApiClient
  readonly secureStorage: SecureStorageService
  readonly activation: ActivationService
  readonly auth: AuthService
  readonly license: LicenseService
  readonly commercialAccess: CommercialAccessService
  readonly commercialAccessPublisher: CommercialAccessPublisher
  readonly bootstrap: BootstrapService
  readonly catalog: CatalogService
  readonly catalogRefresh: CatalogRefreshService
  readonly shiftAuthority: ShiftAuthorityService
  readonly shifts: ShiftService
  readonly checkoutPreview: CheckoutPreviewService
  readonly localSale: LocalSaleService
  readonly saleCompletion: SaleCompletionService
  readonly companyUsers: CompanyUsersService
  readonly connectivity: ConnectivityService
  readonly invoiceUploads: InvoiceUploadWorker
  readonly allocationRecoveries: AllocationRecoveryService
  /** CP4: the main-owned readiness projection and preparation cycle. */
  readonly preparation: PreparationService
  readonly preparationReadiness: PreparationReadinessService
  readonly preparationReconnect: PreparationReconnectService
  /**
   * CP4: the two entry points the IPC layer is allowed to call.
   *
   * Both resolve the owner tuple from main's own session and bootstrap state. Neither accepts an
   * argument, so there is no path by which a renderer could name an owner, a product, a quantity,
   * or a clock — §4's invariant is enforced by the signature.
   */
  readPreparationReadiness(): PreparationReadiness
  runPreparationCycle(): Promise<PreparationCycleResult>
  readonly invoiceUploadFailures: InvoiceUploadFailureReader
  getRuntimeInfo(): RuntimeInfo
  shutdown(): void
}

export function createApplicationServices(): ApplicationServices {
  const runtimeConfig = loadRuntimeConfig()
  const database = openDatabase()

  try {
    runMigrations(database, databaseMigrations)
  } catch (error) {
    closeDatabase(database)
    throw error
  }

  const appSettings = new AppSettingsRepository(database)
  const deviceIdentityRepository = new SqliteDeviceIdentityRepository(database)
  const deviceRegistrationRepository = new DeviceRegistrationRepository(database)
  const secureSecrets = new SecureSecretsRepository(database)
  const sessionMetadata = new SqliteSessionMetadataRepository(database)
  const sessionEpoch = new SessionEpochRepository(database)
  const shiftObservations = new ShiftObservationRepository(database)
  const licenseMetadata = new LicenseMetadataRepository(database)
  const bootstrapState = new BootstrapStateRepository(database)
  const stockAllocations = new StockAllocationRepository(database)
  const allocationRecoveryRepository = new AllocationRecoveryRepository(database, stockAllocations)
  // BH-04B-3: validates and applies server reconciliation evidence (the §3.1 coverage boundary and
  // terminal markers). It holds no transaction of its own — every caller applies it inside the
  // transaction that commits the rest of that response.
  const allocationReconciliation = new AllocationReconciliationService({
    stockAllocations,
    allocationRecoveries: allocationRecoveryRepository
  })
  const bootstrapSnapshot = new BootstrapSnapshotRepository(
    database,
    stockAllocations,
    allocationReconciliation
  )
  const catalogRepository = new CatalogRepository(database)
  const syncQueue = new SyncQueueRepository(database)
  const syncConflicts = new SyncConflictRepository(database)
  const saleAttempts = new SaleAttemptRepository(database)
  const localSaleRepository = new LocalSaleRepository(database)
  const localStock = new LocalStockRepository(database)
  const deviceIdentity = new DeviceIdentityService(deviceIdentityRepository, {
    deviceName: hostname(),
    platform: platform(),
    osVersion: release(),
    appVersion: app.getVersion()
  })
  const secureStorage = new SecureStorageService(secureSecrets, safeStorage)
  const session = new SessionService(sessionMetadata, secureStorage, {
    database,
    epoch: sessionEpoch,
    observations: shiftObservations
  })
  let commercialAccessPublisher: CommercialAccessPublisher | null = null
  // Assigned once the upload worker exists; the connectivity service is constructed before it.
  let invoiceUploadTrigger: (() => void) | null = null
  let allocationRecoveryTrigger: (() => void) | null = null
  const connectivity = new ConnectivityService({
    apiOrigin: runtimeConfig.apiOrigin,
    isOnline: () => net.isOnline(),
    fetchImplementation: (input, init) => net.fetch(input, init),
    onResume: (listener) => {
      powerMonitor.on('resume', listener)
      return () => powerMonitor.off('resume', listener)
    },
    onChange: (snapshot) => {
      broadcastConnectivityChanged(snapshot)
      commercialAccessPublisher?.publishCurrent()

      if (snapshot.status === 'online') {
        // Coming back online is the single most likely moment for a queue to be drainable.
        invoiceUploadTrigger?.()
        allocationRecoveryTrigger?.()
      }
    }
  })

  deviceIdentity.getOrCreate()

  const apiClient = new DesktopApiClient({
    apiOrigin: runtimeConfig.apiOrigin,
    // Shares the Chromium net stack with the connectivity probe (see below). Node's global fetch
    // does not consult the system proxy or OS certificate store, so leaving this on the default
    // would let the health probe and real API traffic disagree about reachability in exactly the
    // network environments (corporate proxy, custom root CA) where that distinction matters most.
    fetchImplementation: (input, init) => net.fetch(input, init),
    getAccessToken: () => secureStorage.getSecret(DESKTOP_ACCESS_TOKEN_KEY),
    getDeviceUuid: () => deviceIdentity.getOrCreate().deviceUuid,
    onAuthenticatedFailure: (error) => session.applyApiFailure(error),
    onRequestOutcome: (outcome) => connectivity.reportRequestOutcome(outcome)
  })

  const activation = new ActivationService(
    database,
    deviceIdentityRepository,
    deviceRegistrationRepository,
    apiClient
  )
  const auth = new AuthService(
    apiClient,
    deviceIdentityRepository,
    sessionMetadata,
    secureStorage,
    session
  )
  const license = new LicenseService(apiClient, licenseMetadata, secureStorage)
  const commercialAccess = new CommercialAccessService({
    session,
    licenseMetadata,
    permissions: bootstrapSnapshot,
    settings: appSettings,
    devices: deviceRegistrationRepository,
    company: bootstrapSnapshot,
    features: bootstrapSnapshot,
    connectivity
  })
  commercialAccessPublisher = new CommercialAccessPublisher(commercialAccess)
  const catalogReadAccess = new CatalogReadAccessService({
    identity: deviceIdentityRepository,
    deviceRegistration: deviceRegistrationRepository,
    session: sessionMetadata,
    secrets: secureStorage,
    company: bootstrapSnapshot,
    permissions: bootstrapSnapshot
  })
  const catalogClock = new CatalogTrustedClockService(appSettings)
  const catalog = new CatalogService(
    catalogRepository,
    catalogReadAccess,
    catalogClock,
    stockAllocations
  )
  const bootstrap = new BootstrapService(
    apiClient,
    deviceIdentityRepository,
    commercialAccess,
    bootstrapSnapshot,
    (result) => {
      if (result.catalogRevision) {
        catalog.markPublished(result.catalogRevision)
      }
      commercialAccessPublisher?.publishCurrent()
    }
  )
  const shiftPermissions = new ShiftPermissions(bootstrapSnapshot)
  const shiftAuthority = new ShiftAuthorityService({
    observations: shiftObservations,
    session: sessionMetadata,
    company: bootstrapSnapshot,
    device: deviceIdentity,
    epoch: sessionEpoch
  })
  const shifts = new ShiftService(apiClient, commercialAccess, shiftPermissions, shiftAuthority)
  // The final `shifts.current()` occurs after license/session/bootstrap refresh work, so a
  // confirmed open shift is recorded under the context completion will actually use.
  const catalogRefresh = new CatalogRefreshService({
    license,
    authorizer: { ensureCatalogReadContext: () => auth.ensureCatalogReadContext() },
    source: bootstrap,
    shiftReconciler: shifts,
    catalog,
    access: commercialAccess,
    accessPublisher: {
      begin: () => commercialAccessPublisher?.begin() ?? 0,
      publish: (revision) => commercialAccessPublisher?.publish(revision)
    },
    stockAllocations
  })
  const checkoutPreview = new CheckoutPreviewService({
    commercialAccess,
    permissions: bootstrapSnapshot,
    shiftAuthority,
    catalog
  })
  const allocationService = new StockAllocationService(stockAllocations)
  const localSale = new LocalSaleService({
    database,
    saleAttempts,
    localSale: localSaleRepository,
    localStock,
    stockAllocations,
    allocationService,
    commercialAccess,
    permissions: bootstrapSnapshot,
    shiftAuthority,
    bootstrapSnapshot,
    catalog,
    connectivity,
    syncQueue
  })
  // CP-5D: the only production caller of `POST /api/v1/desktop/stock-allocations/top-up`. It is
  // main-only and reachable exclusively through `checkout:complete` / `checkout:retry-attempt`;
  // nothing in preload exposes an allocation request, a raw payload, or a generic HTTP method.
  const allocationAcquisition = new AllocationAcquisitionService({
    database,
    apiClient,
    stockAllocations,
    allocationService,
    allocationReconciliation,
    connectivity
  })
  const invoiceUploads = new InvoiceUploadWorker({
    syncQueue,
    recorder: new InvoiceUploadOutcomeRecorder({
      database,
      syncQueue,
      localSale: localSaleRepository,
      syncConflicts,
      allocationReconciliation
    }),
    commercialAccess,
    permissions: bootstrapSnapshot,
    session: sessionMetadata,
    upload: (payloadJson) => uploadInvoice(apiClient, payloadJson),
    // Every worker-visible change — claim, success, retry scheduling, conflict, rejection, pause,
    // resume — reaches the renderer through the one sanitized status contract. A send failure is
    // swallowed by the broadcaster: the queue write has already committed, and a renderer teardown
    // race must never surface as a worker fault.
    onStatusChanged: () => {
      broadcastSyncChanged(invoiceUploads.getStatus())
    }
  })
  const invoiceUploadFailures = new InvoiceUploadFailureReader({
    syncQueue,
    session: sessionMetadata
  })
  const allocationRecoveries = new AllocationRecoveryService({
    database,
    apiClient,
    recoveries: allocationRecoveryRepository,
    stockAllocations,
    syncQueue,
    reconciliation: allocationReconciliation,
    commercialAccess,
    permissions: bootstrapSnapshot,
    owner: () => {
      const context = sessionMetadata.getContext()
      return context.isAuthenticated && context.companyUuid && context.deviceUuid
        ? { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
        : null
    }
  })
  // ---------------------------------------------------------------------------------------------
  // CP4: coordinated offline stock preparation
  // ---------------------------------------------------------------------------------------------
  //
  // The owner tuple is resolved from main's own session and bootstrap state on every call, never
  // cached and never accepted from a renderer (§4: "renderer cannot supply authoritative
  // quantities, ownership, time, or grant rights"). A device with no warehouse assignment has no
  // preparation owner at all, and every entry point below returns null rather than guessing one.
  // Two `app_settings` keys rather than new tables: both are single scalar observations about the
  // *server's* current state, with no history worth keeping and no evidence value if lost.
  const PREPARATION_LICENSE_VALIDATION_KEY = 'preparation.license_validation_uuid'
  const PREPARATION_POLICY_REVISION_KEY = 'preparation.policy_revision'
  const preparationRepository = new PreparationRepository(database, () => new Date().toISOString())
  const preparation = new PreparationService({
    database,
    preparation: preparationRepository,
    stockAllocations,
    apiClient,
    connectivity,
    candidates: {
      // §5.2: main resolves the policy-enabled candidate set itself. Until a policy-visibility
      // contract exists, the honest candidate set is the tracked products this device already holds
      // authority for — never a renderer list, and never "every product in the catalog", which
      // would ask the server to evaluate scopes this device has no business naming.
      resolveCandidates: (owner) => stockAllocations.preparableProductUuids(owner),
      // The captured dependency join. Rows at or below the cycle's own high-water mark whose
      // immutable invoice/allocation journal touches a candidate.
      capturedDependencies: (owner, highWater) =>
        syncQueue.capturedPreparationDependencies(owner, highWater),
      // No policy-visibility contract exists on the desktop yet, so nothing is locally known to be
      // policy-disabled. The server refuses an unconfigured product outright, which is the
      // fail-closed direction: a product wrongly believed eligible is refused, never granted.
      policyDisabledProducts: () => new Set<string>(),
      blockedByUnreleasedHoldProducts: () => new Set<string>(),
      authorityReferences: () => ({
        // §5.2: authority references identify the exact locally staged artifacts, and the backend
        // resolves them to its own rows — it never accepts them as claims, and it replaces the
        // license validation with one anchored to its own `prepared_at`. A device that has staged
        // no license validation sends null rather than a guess.
        licenseValidationUuid: appSettings.get(PREPARATION_LICENSE_VALIDATION_KEY),
        catalogRevision: catalog.getStatus().contract?.revision ?? null,
        // Revision 0 means "this device has observed no policy revision". The server compares it to
        // the applied revision and answers 409 POLICY_REVISION_STALE — terminal, creating nothing —
        // and names the current revision, which the next cycle then carries. That is the honest
        // bootstrap for a value the desktop has no other way to learn.
        requestedPolicyRevision: Number(appSettings.get(PREPARATION_POLICY_REVISION_KEY) ?? '0')
      }),
      sessionEpoch: () => sessionEpoch.current()
    },
    now: () => new Date().toISOString(),
    onPolicyRevisionObserved: (revision) => {
      appSettings.set(PREPARATION_POLICY_REVISION_KEY, String(revision))
    }
  })
  const preparationReadiness = new PreparationReadinessService({
    preparation: preparationRepository,
    stockAllocations,
    trustedClock: catalogClock
  })
  const preparationReconnect = new PreparationReconnectService({
    // Steps 1 and 2 are reads and create no authority, so they may precede upload (§7.3). Wiring
    // them to the *existing* services is deliberate: their monotonic-reconciliation guarantees are
    // what make refresh-before-upload safe, and re-implementing them here would fork that promise.
    restoreAuthority: async () => {
      // `CatalogRefreshService.refresh()` already validates the license first — an overdue license
      // denies `canSync`, so bootstrap and everything after it cannot succeed until validation has
      // run and been persisted (§7.3 item 1).
      const result = await catalogRefresh.refresh()
      return { ok: result.status.status !== 'unavailable', detail: result.status.status }
    },
    refreshAuthoritativeState: async () => {
      const result = await bootstrap.refresh()
      return { ok: result.isComplete, detail: result.snapshotVersion }
    },
    drainCapturedDependencies: async () => {
      invoiceUploads.requestRun()
      return { ok: true }
    },
    preparation
  })

  /**
   * The owner tuple, resolved fresh on every call from main's own state.
   *
   * A device that is not authenticated, or has no warehouse assignment, has no preparation owner at
   * all — and every caller below reports that honestly rather than guessing one. §5.2: presence of a
   * request never changes owner/warehouse scope.
   */
  const preparationOwner = (): {
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly warehouseUuid: string
  } | null => {
    const context = sessionMetadata.getContext()
    const warehouse = bootstrapSnapshot.getWarehouse()

    if (!context.isAuthenticated || !context.companyUuid || !context.deviceUuid || !warehouse) {
      return null
    }

    return {
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid,
      warehouseUuid: warehouse.warehouseUuid
    }
  }

  const readPreparationReadiness = (): PreparationReadiness => {
    const owner = preparationOwner()

    if (owner === null) {
      return {
        available: false,
        time: {
          state: 'not_prepared',
          preparedAt: null,
          requestedDurationSeconds: null,
          originalResult: null,
          effectiveReadyUntil: null,
          remainingSeconds: 0,
          limitingReason: null,
          tiedLimitingReasons: [],
          newlyObservedRestriction: null,
          lastTrustedObservationAt: null
        },
        quantity: { state: 'zero', products: [] },
        blockedProducts: [],
        unresolvedOperations: []
      }
    }

    // The *sell* decision specifically: preparation exists to keep a workstation able to sell, so
    // losing sell authority blocks readiness even while sync authority is intact.
    const sellAccess = commercialAccess.evaluate('sell')
    const license = licenseMetadata.getStatus()

    return preparationReadiness.project(owner, {
      // Boundaries observed since preparation. Each may only shorten the window (§8.5); a later one
      // is ignored, which is why they are passed as candidates rather than as a replacement.
      observedBoundaries: [
        ...(license?.nextValidationDueAt
          ? [{ reason: 'license_revalidation_due', deadline: license.nextValidationDueAt }]
          : []),
        ...(catalog.getStatus().contract?.validUntil
          ? [
              {
                reason: 'catalog_expires',
                deadline: catalog.getStatus().contract?.validUntil as string
              }
            ]
          : [])
      ],
      // A live check that blocks readiness regardless of remaining time (§8.5). A revoked or
      // non-selling device is not "ready" merely because a past decision said so.
      blockingRestriction: sellAccess.allowed ? null : (sellAccess.reason ?? 'access_denied'),
      sessionEpoch: sessionEpoch.current(),
      lastTrustedObservationAt: license?.validatedAt ?? null
    })
  }

  const runPreparationCycle = async (): Promise<PreparationCycleResult> => {
    const owner = preparationOwner()

    if (owner === null) {
      return { outcome: 'unavailable', reason: 'workstation_unassigned' }
    }

    const outcome = await preparation.runCycle(owner)

    return {
      outcome: outcome.kind,
      reason: 'reason' in outcome ? outcome.reason : null
    }
  }

  invoiceUploadTrigger = () => invoiceUploads.requestRun()
  allocationRecoveryTrigger = () => {
    void allocationRecoveries.resume().catch(() => undefined)
  }
  // CP-3G-4A. Closes the verified gap where restoring authority while already online left the
  // worker paused until backoff, a restart, another sale, or a manual trigger.
  //
  // `CommercialAccessPublisher.publish()` is the authoritative main-owned access-change point:
  // licence validation, **bootstrap-refresh completion** (which is what restores a revoked
  // `pos.invoice.upload`), catalog refresh and connectivity all route through it, so this single
  // subscription covers permission restoration as well — no polling, and no fabricated event.
  //
  // It is a scheduling hint and nothing more. The worker still re-runs `assertAllowed('sync')`,
  // the `pos.invoice.upload` check, session ownership, row eligibility and payload integrity
  // immediately before every dispatch, so a hint that arrives while access is still denied simply
  // re-pauses without sending anything.
  const unsubscribeAccessTrigger = subscribeInvoiceUploadTriggers({
    accessPublisher: commercialAccessPublisher,
    worker: invoiceUploads
  })
  const unsubscribeRecoveryAccessTrigger = commercialAccessPublisher.onPublished(() => {
    allocationRecoveryTrigger?.()
  })
  // CP4 §7.3: the production preparation trigger.
  //
  // Subscribed to the same authoritative access-change point as the upload and recovery workers.
  // `CommercialAccessPublisher.publish()` fires on licence validation, bootstrap-refresh
  // completion, catalog refresh and connectivity, so this covers "connectivity returned" and
  // "authority was restored" without polling and without a fabricated event of its own.
  //
  // It is a scheduling hint and nothing more. `runCycle()` re-resolves the owner, re-reads
  // connectivity, re-captures its own bounded boundary and re-partitions on every call, so a hint
  // that arrives while the device is offline, unassigned, or still blocked simply does nothing —
  // and a hint that arrives while an operation is unresolved replays that operation's frozen bytes
  // rather than starting a new one (§5.6).
  //
  // Deliberately fire-and-forget: a preparation failure must never surface as an access-publish
  // fault, and every outcome it can reach is already persisted durably by the cycle itself.
  const unsubscribePreparationTrigger = commercialAccessPublisher.onPublished(() => {
    void runPreparationCycle().catch(() => undefined)
  })
  const saleCompletion = new SaleCompletionService({
    localSale,
    acquisition: allocationAcquisition,
    // A sale that just queued a row should not wait for an unrelated trigger to be uploaded.
    onSaleCommitted: () => invoiceUploads.requestRun()
  })
  const companyUsers = new CompanyUsersService(apiClient, bootstrapSnapshot)

  return {
    runtimeConfig,
    database,
    appSettings,
    deviceIdentity,
    deviceRegistration: deviceRegistrationRepository,
    session,
    licenseMetadata,
    bootstrapState,
    syncQueue,
    syncConflicts,
    apiClient,
    secureStorage,
    activation,
    auth,
    license,
    commercialAccess,
    commercialAccessPublisher,
    bootstrap,
    catalog,
    catalogRefresh,
    shiftAuthority,
    shifts,
    checkoutPreview,
    localSale,
    saleCompletion,
    companyUsers,
    connectivity,
    invoiceUploads,
    allocationRecoveries,
    preparation,
    preparationReadiness,
    preparationReconnect,
    readPreparationReadiness,
    runPreparationCycle,
    invoiceUploadFailures,
    getRuntimeInfo: () =>
      runtimeInfoSchema.parse({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        platform: process.platform,
        apiConfiguration: runtimeConfig.apiConfiguration
      }),
    shutdown: () => {
      unsubscribeAccessTrigger()
      unsubscribeRecoveryAccessTrigger()
      unsubscribePreparationTrigger()
      invoiceUploads.shutdown()
      connectivity.shutdown()
      apiClient.shutdown()
      closeDatabase(database)
    }
  }
}
