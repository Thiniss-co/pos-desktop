import { app, BrowserWindow, dialog, net, powerMonitor, safeStorage, webContents } from 'electron'
import { ProductImageRepository } from '../repositories/productImage.repository'
import { ProductImageSyncService } from '../services/productImageSync.service'
import { AttemptSettlementService } from '../services/attemptSettlement.service'
import { broadcastAttemptsChanged } from '../ipc/checkout.ipc'
import { CatalogInstallGate, InstallDeferredError } from '../services/catalogInstallGate.service'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { isApiTraceEnabled } from '../http/apiTrace'
import { RenewalCoordinator } from '../services/renewalCoordinator.service'
import { captureRenewalOwner, type RenewalOwner } from '../services/renewalOwner'
import { readFile } from 'node:fs/promises'
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
import { LocalRefundRepository } from '../repositories/localRefund.repository'
import { LocalStockRepository } from '../repositories/localStock.repository'
import { ReceiptContextRepository } from '../repositories/receiptContext.repository'
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
import { ServerTimeEstimator } from '../sync/serverTimeEstimator'
import { UploadDependencyRepository } from '../repositories/uploadDependency.repository'
import { uploadInvoice } from '../sync/invoiceUpload.client'
import { ActivationService } from '../services/activation.service'
import { AllocationAcquisitionService } from '../services/allocationAcquisition.service'
import { AllocationDispatchRepository } from '../repositories/allocationDispatch.repository'
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
import { ReceiptContextCaptureService } from '../receipt/receiptContextCapture.service'
import { ReceiptAccessService } from '../receipt/receiptAccess.service'
import { ReceiptDocumentService } from '../receipt/receiptDocument.service'
import { PrinterSettingsService } from '../receipt/printerSettings.service'
import { ReceiptPrintJobRepository } from '../repositories/receiptPrintJob.repository'
import { ReceiptPrintingService } from '../receipt/receiptPrinting.service'
import { ReceiptProfileRepository } from '../repositories/receiptProfile.repository'
import { ReceiptProfileSyncService } from '../receipt/receiptProfileSync.service'
import { ReceiptProfileAdminService } from '../receipt/receiptProfileAdmin.service'
import {
  destroySharedReceiptRenderWindow,
  getSharedReceiptRenderWindow
} from '../receipt/receiptRenderer'
import { SaleCompletionService } from '../services/saleCompletion.service'
import { RefundAccessService } from '../services/refundAccess.service'
import { RefundService } from '../services/refund.service'
import { uploadRefund } from '../sync/refundUpload.client'
import { SecureStorageService } from '../services/secureStorage.service'
import { SessionService } from '../services/session.service'
import { ShiftAuthorityService } from '../services/shiftAuthority.service'
import { ShiftService } from '../services/shift.service'
import { ShiftPermissions } from '../services/shiftPermissions'
import { OfflineSaleAuthorityRepository } from '../repositories/offlineSaleAuthority.repository'
import { OfflineSaleReadinessService } from '../services/offlineSaleReadiness.service'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'

/**
 * PS6 §14.3: denial reasons that are CATEGORICAL — not time comparisons.
 *
 * These produce no countdown and are reported with their own reason. A time-based denial is already
 * expressed by `remainingSeconds`, so listing one here would report the same fact twice.
 */
const CATEGORICAL_SELL_BLOCK_REASONS: ReadonlySet<string> = new Set([
  'device-not-registered',
  'device-revoked',
  'device-blocked',
  'session-invalid',
  'permission-denied',
  'feature-not-enabled',
  'company-inactive',
  'shift-not-open'
])
import { StockAllocationService } from '../services/stockAllocation.service'
import { ConnectivityService } from '../services/connectivity.service'
import { broadcastConnectivityChanged } from '../ipc/connectivity.ipc'
import { CommercialAccessPublisher } from '../ipc/license.ipc'
import { broadcastSyncChanged } from '../ipc/sync.ipc'
import { broadcastCatalogChanged } from '../ipc/catalog.ipc'
import { AllocationDispatchReconciler } from '../services/allocationDispatchReconciler.service'
import { StockViewService } from '../services/stockView.service'
import { SupportIssuesService } from '../services/supportIssues.service'
import { createDeviceHeartbeat, type DeviceHeartbeatHandle } from './deviceHeartbeatWiring'

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
  readonly renewal: RenewalCoordinator
  readonly installGate: CatalogInstallGate
  readonly attemptSettlement: AttemptSettlementService
  readonly commercialAccess: CommercialAccessService
  readonly commercialAccessPublisher: CommercialAccessPublisher
  readonly bootstrap: BootstrapService
  readonly catalog: CatalogService
  readonly catalogRefresh: CatalogRefreshService
  readonly shiftAuthority: ShiftAuthorityService
  readonly shifts: ShiftService
  readonly checkoutPreview: CheckoutPreviewService
  readonly localSale: LocalSaleService
  readonly localSaleRepository: LocalSaleRepository
  readonly saleCompletion: SaleCompletionService
  readonly refunds: RefundService
  readonly localRefunds: LocalRefundRepository
  readonly receiptAccess: ReceiptAccessService
  readonly printerSettings: PrinterSettingsService
  readonly receiptPrinting: ReceiptPrintingService
  readonly receiptProfileAdmin: ReceiptProfileAdminService
  readonly companyUsers: CompanyUsersService
  readonly connectivity: ConnectivityService
  /** POS reliability rev 3: separated, read-only stock information for POS catalog reads. */
  readonly stockView: StockViewService
  /** POS reliability rev 3: owner of every outstanding allocation request identity. */
  readonly allocationDispatchReconciler: AllocationDispatchReconciler
  /** Presence-only heartbeat; runs only while a cashier session is valid. */
  readonly deviceHeartbeat: DeviceHeartbeatHandle
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
  readOfflineSaleReadiness(): OfflineSaleReadiness
  readPreparationReadiness(): PreparationReadiness
  runPreparationCycle(): Promise<PreparationCycleResult>
  readonly invoiceUploadFailures: InvoiceUploadFailureReader
  /** Read-only "needs attention" projection for the Sync page (dispatch/legacy/recovery evidence). */
  readonly supportIssues: SupportIssuesService
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
  // Owner UX plan P8: product image references (applied inside the bootstrap persist transaction)
  // and their verified bytes.
  const productImages = new ProductImageRepository(database)
  const bootstrapSnapshot = new BootstrapSnapshotRepository(
    database,
    stockAllocations,
    allocationReconciliation,
    productImages
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
  // Assigned once the API client and access publisher exist (below).
  let deviceHeartbeat: DeviceHeartbeatHandle | null = null
  let allocationDispatchTrigger: (() => void) | null = null
  const session = new SessionService(sessionMetadata, secureStorage, {
    database,
    epoch: sessionEpoch,
    observations: shiftObservations,
    onChanged: () => {
      deviceHeartbeat?.notifySessionChanged()
      allocationDispatchTrigger?.()
      renewalTrigger?.onSessionChanged()
    }
  })
  // Assigned once the renewal coordinator exists (below).
  let renewalTrigger: RenewalCoordinator | null = null
  let commercialAccessPublisher: CommercialAccessPublisher | null = null
  // Assigned once the upload worker exists; the connectivity service is constructed before it.
  let invoiceUploadTrigger: (() => void) | null = null
  let allocationRecoveryTrigger: (() => void) | null = null
  // Rev 4 §10.1: memory-only server-time samples (license `server_time`, `/up` `Date`). Suspend and
  // resume invalidate them, because monotonic time may not have tracked real time across a sleep.
  const serverTime = new ServerTimeEstimator()
  const invalidateServerTime = (): void => serverTime.invalidate()
  powerMonitor.on('suspend', invalidateServerTime)
  powerMonitor.on('resume', invalidateServerTime)
  const connectivity = new ConnectivityService({
    apiOrigin: runtimeConfig.apiOrigin,
    isOnline: () => net.isOnline(),
    fetchImplementation: (input, init) => net.fetch(input, init),
    onServerTimeSample: (sample) => serverTime.offer(sample),
    onResume: (listener) => {
      const both = (): void => {
        listener()
        renewalTrigger?.onResume()
      }
      powerMonitor.on('resume', both)
      return () => powerMonitor.off('resume', both)
    },
    onChange: (snapshot) => {
      broadcastConnectivityChanged(snapshot)
      deviceHeartbeat?.notifyConnectivity(snapshot)
      commercialAccessPublisher?.publishCurrent()

      if (snapshot.status === 'online') {
        // Coming back online is the single most likely moment for a queue to be drainable.
        invoiceUploadTrigger?.()
        allocationRecoveryTrigger?.()
        allocationDispatchTrigger?.()
        renewalTrigger?.onOnline()
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
  // Rev 4 §7.1: the owner a renewal belongs to — captured before each leg's request and re-checked
  // as the first statement of that leg's single write transaction.
  const renewalOwner = (): RenewalOwner | null =>
    captureRenewalOwner({
      session: sessionMetadata,
      epoch: sessionEpoch,
      assignment: bootstrapSnapshot
    })
  // PS4 §6.2: production wiring for the stored offline-sale authority. Without a row here the
  // commit path takes the legacy branch, so this is what makes the mode reachable at all — and its
  // absence, not a flag, is what keeps every unconfigured device behaving exactly as it does today.
  const offlineSaleAuthorities = new OfflineSaleAuthorityRepository(database)
  // Rev 4 §10.1: server-time samples from each license leg (the estimator is attached below).
  const license = new LicenseService(apiClient, licenseMetadata, secureStorage, undefined, {
    database,
    owner: renewalOwner,
    offlineSaleAuthorities,
    onServerTimeSample: (sample) => serverTime.offer(sample)
  })
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
  const heartbeat = createDeviceHeartbeat({
    apiClient,
    session: sessionMetadata,
    sessionEpoch,
    secrets: secureStorage,
    deviceIdentity: deviceIdentityRepository, // read-only get(); never getOrCreate()
    permissions: bootstrapSnapshot,
    deviceRegistration: deviceRegistrationRepository,
    commercialAccess,
    accessPublisher: commercialAccessPublisher
  })
  deviceHeartbeat = heartbeat
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
    stockAllocations,
    { repository: productImages, companyUuid: () => sessionMetadata.getContext().companyUuid }
  )
  // Receipt-printing plan §D-11 -- constructed before `bootstrap` because printing's branding
  // rendering reads the mirror the sync service will later populate; wired here so the mirror
  // always exists once printing needs it.
  const receiptProfileRepository = new ReceiptProfileRepository(database)
  const receiptProfileSync = new ReceiptProfileSyncService({
    repository: receiptProfileRepository,
    apiClient
  })
  // Owner UX plan P8: background image downloads after a persisted bootstrap. The context token is
  // the signed-in owner; any change (sign-out, another user, company or device, a new epoch) stops a
  // sweep and discards what it fetched.
  const productImageSync = new ProductImageSyncService({
    repository: productImages,
    apiClient,
    contextKey: () => {
      const context = sessionMetadata.getContext()
      return context.isAuthenticated &&
        context.companyUuid &&
        context.deviceUuid &&
        context.userUuid
        ? `${context.companyUuid}|${context.deviceUuid}|${context.userUuid}|${sessionEpoch.current()}`
        : null
    },
    onStored: () => broadcastCatalogChanged({ reason: 'stock', revision: null }),
    log: (line) => console.log(line)
  })
  let settleAfterInstall: () => void = () => undefined
  // Rev 4 §8: the catalog-install lifecycle. Late-bound to the completion service (built below).
  let completionInFlight: () => boolean = () => false
  const catalogNeedsInstall = (): boolean => {
    const status = catalog.getStatus()
    return status.contract === null || status.status === 'stale'
  }
  const hasGatingClaim = (): boolean => {
    const context = sessionMetadata.getContext()
    if (
      !context.isAuthenticated ||
      !context.companyUuid ||
      !context.deviceUuid ||
      !context.userUuid
    ) {
      return false
    }
    const claimed = saleAttempts.findBlockingForOwner({
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid,
      userUuid: context.userUuid
    })
    if (!claimed || claimed.intentJson === null) {
      return false
    }
    let revision: unknown = null
    try {
      revision = (JSON.parse(claimed.intentJson) as { catalogRevision?: unknown }).catalogRevision
    } catch {
      return true
    }
    const status = catalog.getStatus()
    // Only a claim the install would NEWLY supersede gates it: its revision is the installed one and
    // that catalog is still valid. A claim on an already superseded or stale revision cannot commit.
    return status.contract?.revision === revision && status.status !== 'stale'
  }
  const installGate = new CatalogInstallGate({
    appWindowIds: () =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:'))
        .map((w) => w.webContents.id),
    send: (id, channel, payload) => {
      const contents = webContents.fromId(id)
      if (contents && !contents.isDestroyed()) {
        contents.send(
          channel === 'hold' ? IPC_CHANNELS.catalogInstallHold : IPC_CHANNELS.catalogInstallRelease,
          payload
        )
      }
    },
    hasGatingClaim,
    completionInFlight: () => completionInFlight(),
    catalogNeedsInstall,
    log: (line) => {
      if (isApiTraceEnabled()) {
        console.log(line)
      }
    }
  })
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
      // Rev 3: fired after the install transaction committed; the renderer re-reads coherently.
      broadcastCatalogChanged({ reason: 'snapshot', revision: result.catalogRevision ?? null })
      // Rev 4 §9.1: an install may have superseded a claimed attempt that can no longer commit.
      settleAfterInstall()
    },
    undefined,
    // Mirrors the negotiated `receipt_profile` block for the responding company and the current
    // session user only; never fails or delays bootstrap (see BootstrapReceiptProfileSync).
    sessionMetadata,
    receiptProfileSync,
    { owner: renewalOwner, installGate, productImageSync }
  )
  // Rev 4 §7: the single owner of license validation and renewal timing. The catalog leg here only
  // installs when the catalog is missing or stale (selling is impossible anyway); the gated
  // background install lives in the catalog-install lifecycle.
  const renewal = new RenewalCoordinator({
    license,
    owner: renewalOwner,
    authorityWindow: (owner) => {
      const row = offlineSaleAuthorities.latestForWarehouse(
        owner.companyUuid,
        owner.deviceUuid,
        owner.warehouseUuid
      )
      return row ? { start: row.notBefore, end: row.notAfter } : null
    },
    catalogWindow: () => {
      const contract = catalogRepository.getContract()
      return contract ? { start: contract.generatedAt, end: contract.validUntil } : null
    },
    catalogNeedsInstall,
    // Rev 4 §8.3 background path: never download a snapshot that could not be installed now. The
    // gate resolves `stale` itself when nothing can be sold anyway.
    catalogLeg: async () => {
      if (!catalogNeedsInstall() && !installGate.canStartBackgroundInstall()) {
        throw new InstallDeferredError('busy')
      }
      await bootstrap.refresh()
    },
    onRenewed: () => commercialAccessPublisher?.publishCurrent(),
    log: (line) => {
      if (isApiTraceEnabled()) {
        console.log(line)
      }
    }
  })
  renewalTrigger = renewal
  // Receipt-printing plan §D-11: the CompanyAdmin editor. Session is resolved at the IPC layer;
  // this service re-checks the mirrored `canManage` verdict and the online requirement itself.
  const receiptProfileAdmin = new ReceiptProfileAdminService({
    repository: receiptProfileRepository,
    sync: receiptProfileSync,
    apiClient,
    connectivity,
    dialog,
    readFile: (filePath) => readFile(filePath),
    refreshBootstrap: () => bootstrap.refresh()
  })
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
    license: { validate: () => renewal.validateLicense('catalog-refresh') },
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
  // Receipt-printing plan §D-2: additive to the existing sale/refund commit paths -- absence of
  // any of its own dependencies is never possible here (all are already constructed above), so
  // this is always wired in production. Tests that construct `LocalSaleDependencies`/
  // `RefundServiceDependencies` directly simply omit `receiptContext` and keep working unchanged.
  const receiptContextRepository = new ReceiptContextRepository(database)
  const receiptContextCapture = new ReceiptContextCaptureService({
    receiptContext: receiptContextRepository,
    bootstrapSnapshot,
    sessionMetadata,
    customers: {
      findNameAndTaxNumber(customerUuid: string) {
        const row = database
          .prepare('SELECT name, tax_number AS taxNumber FROM customers WHERE id = ?')
          .get(customerUuid) as { name: string; taxNumber: string | null } | undefined
        return row ? { name: row.name, taxNumber: row.taxNumber } : null
      }
    }
  })
  // POS reliability rev 3: durable top-up request identities (migration 0016).
  const allocationDispatches = new AllocationDispatchRepository(database)
  const localSale = new LocalSaleService({
    database,
    saleAttempts,
    allocationDispatches,
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
    syncQueue,
    offlineSaleAuthorities,
    // Rev 4 §5.2: the single trusted commit instant t1.
    trustedClock: catalogClock,
    installGate,
    receiptContext: receiptContextCapture
  })
  const localRefundRepository = new LocalRefundRepository(database)
  const refundAccess = new RefundAccessService({
    permissions: bootstrapSnapshot,
    commercialAccess
  })
  const refunds = new RefundService({
    apiClient,
    localSale: localSaleRepository,
    localRefunds: localRefundRepository,
    access: refundAccess,
    shiftAuthority,
    catalog,
    uploadRefund,
    receiptContext: receiptContextCapture
  })
  // Startup crash recovery (plan §3b): every `dispatched` row this device owns becomes
  // `unresolved` before anything else touches it. Best-effort -- a session with no established
  // owner yet (e.g. before first login on a fresh install) has nothing to sweep.
  try {
    const owner = shiftAuthority.captureContext()
    refunds.sweepOnStartup(owner)
  } catch {
    // No established session yet; nothing was dispatched under it either.
  }

  // Receipt-printing plan §D-3/§D-5/§D-6/BD-2.
  const receiptAccess = new ReceiptAccessService({ shiftAuthority, permissions: bootstrapSnapshot })
  const receiptDocument = new ReceiptDocumentService({
    localSale: localSaleRepository,
    localRefunds: localRefundRepository,
    receiptContext: receiptContextRepository,
    bootstrapSnapshot,
    receiptProfile: receiptProfileRepository
  })
  const printerSettings = new PrinterSettingsService(appSettings)
  const receiptPrintJobs = new ReceiptPrintJobRepository(database)
  const receiptPrinting = new ReceiptPrintingService({
    jobs: receiptPrintJobs,
    access: receiptAccess,
    documents: receiptDocument,
    printerSettings,
    localSale: localSaleRepository,
    localRefunds: localRefundRepository,
    getPrinters: () => getSharedReceiptRenderWindow().listPrinters(),
    getRenderWindow: () => getSharedReceiptRenderWindow(),
    receiptProfile: receiptProfileRepository
  })
  // Plan §D-5 E T17: every job left `queued`/`preparing`/`dispatching` by a prior process becomes
  // terminal before anything else can claim a reservation. Runs before IPC registration.
  receiptPrinting.reconcileStartup()

  // CP-5D: the only production caller of `POST /api/v1/desktop/stock-allocations/top-up`. It is
  // main-only and reachable exclusively through `checkout:complete` / `checkout:retry-attempt`;
  // nothing in preload exposes an allocation request, a raw payload, or a generic HTTP method.
  const allocationAcquisition = new AllocationAcquisitionService({
    database,
    apiClient,
    stockAllocations,
    allocationService,
    allocationReconciliation,
    connectivity,
    allocationDispatches
  })
  const allocationDispatchReconciler = new AllocationDispatchReconciler({
    dispatches: allocationDispatches,
    acquisition: allocationAcquisition,
    connectivity,
    apiClient,
    owner: () => {
      try {
        const context = shiftAuthority.captureContext()
        return { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
      } catch {
        return null
      }
    },
    allocationCapabilitySupported: () => stockAllocations.getCapability()?.state === 'supported',
    onGrantsChanged: () => {
      broadcastCatalogChanged({ reason: 'stock', revision: null })
      // A top-up may carry a coverage boundary that releases a held upload (Rev 4 §10.5).
      invoiceUploadTrigger?.()
    },
    // The Sync page's "needs attention" list re-reads on the sanitized sync status push.
    onRequestsResolved: () => broadcastSyncChanged(invoiceUploads.getStatus())
  })
  allocationDispatchTrigger = () => allocationDispatchReconciler.requestRun()
  const uploadDependencies = new UploadDependencyRepository(database)
  const supportIssues = new SupportIssuesService({
    session: sessionMetadata,
    allocationDispatches,
    saleAttempts,
    recoverySummary: (attempt) => localSale.recoverySummary(attempt),
    productName: (productUuid) =>
      catalogRepository.getProduct(productUuid)?.name.slice(0, 300) ?? null,
    uploadDependencies
  })
  const stockView = new StockViewService({
    database,
    catalog,
    bootstrapSnapshot,
    stockAllocations,
    offlineSaleAuthorities,
    clock: catalogClock,
    owner: () => {
      try {
        const context = shiftAuthority.captureContext()
        return { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
      } catch {
        return null
      }
    }
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
    // Rev 4 §10.2: v3 items wait for a usable server-time bound; a missing one requests a probe.
    timeGate: {
      lowerBound: () => serverTime.lowerBound(),
      requestSample: () => {
        void connectivity.ensureFresh(0)
      }
    },
    // Rev 4 §10.3: allocation-chain dependencies, judged inside the claim transaction.
    uploadDependencies,
    log: (line) => {
      if (isApiTraceEnabled()) {
        console.log(line)
      }
    },
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

  /**
   * PS6 §14.3: the offline-sell readiness projection.
   *
   * Reuses `preparationOwner()` rather than resolving a second owner tuple — two independent
   * resolutions of "who am I" is how they drift, and this one must agree exactly with the tuple the
   * commit path uses to find its authority.
   */
  const offlineSaleReadiness = new OfflineSaleReadinessService({
    database,
    offlineSaleAuthorities,
    trustedClock: catalogClock,
    resolveOwner: preparationOwner,
    lastLicenseValidationAt: () => licenseMetadata.getTrustedTimeAnchor(),
    resolveBoundaries: () => {
      // The catalog contract is the one boundary that can move EARLIER after issuance from the
      // desktop's own point of view: the server already clipped `not_after` to every boundary it
      // knew at issuance, and a later catalog refresh can shorten the usable window.
      const contract = catalogRepository.getContract()
      const decision = commercialAccess.evaluate('sell')

      return {
        catalogValidUntil: contract?.validUntil ?? null,
        // Categorical only. A time-based denial is already expressed by the countdown, and folding
        // it in here would report the same fact twice in two different shapes (§14.3).
        categoricalBlocks:
          decision.allowed || decision.reason == null
            ? []
            : CATEGORICAL_SELL_BLOCK_REASONS.has(decision.reason)
              ? [decision.reason]
              : []
      }
    }
  })

  const readOfflineSaleReadiness = (): OfflineSaleReadiness => offlineSaleReadiness.read()

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
    broadcastCatalogChanged({ reason: 'stock', revision: null })

    return {
      outcome: outcome.kind,
      reason: 'reason' in outcome ? outcome.reason : null
    }
  }

  invoiceUploadTrigger = () => invoiceUploads.requestRun()
  // A fresh server-time sample may make a deferred v3 item sendable.
  const unsubscribeServerTimeTrigger = serverTime.onSample(() => invoiceUploads.requestRun())
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
    // Rev 4 §5.1: PP checkout skips foreground acquisition; without an authority and online, one
    // single-flight license leg first.
    renewal,
    isOnline: () => connectivity.getSnapshot().status === 'online',
    // A sale that just queued a row should not wait for an unrelated trigger to be uploaded.
    onSaleCommitted: () => {
      invoiceUploads.requestRun()
      // Rev 4 §14: a commit under a physical-presence authority skips acquisition, so a reservation
      // request left outstanding by an earlier lost answer is re-sent (identical bytes) by the
      // reconciler, not by the retry. Nothing else would wake it while connectivity stays online.
      allocationDispatchTrigger?.()
    },
    // Rev 3: the renderer re-reads the visible stock figures locally (no network request).
    onStockMayHaveChanged: () => broadcastCatalogChanged({ reason: 'stock', revision: null }),
    // Receipt-printing plan §D-5 D: main-owned auto-print, scheduled after this tick (never inside
    // the commit's own call stack) and fully isolated from the sale outcome by both this catch and
    // the try/catch already wrapping every `onSaleCommittedForPrint` call in
    // `SaleCompletionService` itself.
    onSaleCommittedForPrint: ({ invoiceLocalUuid, companyUuid, deviceUuid, userUuid }) => {
      setImmediate(() => {
        receiptPrinting
          .runAutoPrintForSale(
            { companyUuid, deviceUuid, userUuid, sessionEpoch: sessionEpoch.current() },
            invoiceLocalUuid
          )
          .catch(() => {
            // Best-effort. A failed auto-print attempt is recorded in receipt_print_jobs (when it
            // got that far) and is never retried automatically; it never revisits the sale.
          })
      })
    }
  })
  completionInFlight = () => saleCompletion.hasAnyInFlight()
  // Rev 4 §9.1: settle a provably superseded claimed attempt (never a legacy one) after installs.
  const attemptSettlement = new AttemptSettlementService({
    database,
    saleAttempts,
    owner: () => {
      const context = sessionMetadata.getContext()
      return context.isAuthenticated &&
        context.companyUuid &&
        context.deviceUuid &&
        context.userUuid
        ? {
            companyUuid: context.companyUuid,
            deviceUuid: context.deviceUuid,
            userUuid: context.userUuid
          }
        : null
    },
    catalog,
    completionInFlight: (attemptKey) => saleCompletion.isInFlight(attemptKey),
    now: () => catalogClock.now()?.now ?? new Date(),
    onSettled: () => {
      broadcastAttemptsChanged('settled')
      broadcastSyncChanged(invoiceUploads.getStatus())
    }
  })
  settleAfterInstall = () => {
    try {
      attemptSettlement.settleSuperseded()
    } catch {
      // Settlement is a best-effort cleanup; a failure leaves the attempt claimed (the safe side).
    }
  }
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
    renewal,
    installGate,
    attemptSettlement,
    commercialAccess,
    commercialAccessPublisher,
    bootstrap,
    catalog,
    catalogRefresh,
    shiftAuthority,
    shifts,
    checkoutPreview,
    localSale,
    localSaleRepository,
    saleCompletion,
    refunds,
    localRefunds: localRefundRepository,
    receiptAccess,
    printerSettings,
    receiptPrinting,
    receiptProfileAdmin,
    companyUsers,
    connectivity,
    stockView,
    allocationDispatchReconciler,
    deviceHeartbeat: heartbeat,
    invoiceUploads,
    allocationRecoveries,
    preparation,
    preparationReadiness,
    preparationReconnect,
    readOfflineSaleReadiness,
    readPreparationReadiness,
    runPreparationCycle,
    invoiceUploadFailures,
    supportIssues,
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
      unsubscribeServerTimeTrigger()
      powerMonitor.off('suspend', invalidateServerTime)
      powerMonitor.off('resume', invalidateServerTime)
      unsubscribeRecoveryAccessTrigger()
      unsubscribePreparationTrigger()
      heartbeat.dispose()
      renewal.stop()
      allocationDispatchReconciler.stop()
      invoiceUploads.shutdown()
      connectivity.shutdown()
      apiClient.shutdown()
      destroySharedReceiptRenderWindow()
      closeDatabase(database)
    }
  }
}
