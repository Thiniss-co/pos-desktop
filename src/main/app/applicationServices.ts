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
      invoiceUploads.shutdown()
      connectivity.shutdown()
      apiClient.shutdown()
      closeDatabase(database)
    }
  }
}
