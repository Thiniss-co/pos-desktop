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
import { SecureSecretsRepository } from '../repositories/secureSecrets.repository'
import { SqliteSessionMetadataRepository } from '../repositories/sessionMetadata.repository'
import { SyncConflictRepository } from '../repositories/syncConflict.repository'
import { SyncQueueRepository } from '../repositories/syncQueue.repository'
import { ActivationService } from '../services/activation.service'
import { AuthService, DESKTOP_ACCESS_TOKEN_KEY } from '../services/auth.service'
import { BootstrapService } from '../services/bootstrap.service'
import { CatalogReadAccessService } from '../services/catalogReadAccess.service'
import { CatalogService } from '../services/catalog.service'
import { CatalogTrustedClockService } from '../services/catalogTrustedClock.service'
import { CompanyUsersService } from '../services/companyUsers.service'
import { CommercialAccessService } from '../services/commercialAccess.service'
import { DeviceIdentityService } from '../services/deviceIdentity.service'
import { LicenseService } from '../services/license.service'
import { SecureStorageService } from '../services/secureStorage.service'
import { SessionService } from '../services/session.service'
import { ShiftService } from '../services/shift.service'
import { ShiftPermissions } from '../services/shiftPermissions'
import { ConnectivityService } from '../services/connectivity.service'
import { broadcastConnectivityChanged } from '../ipc/connectivity.ipc'
import { CommercialAccessPublisher } from '../ipc/license.ipc'

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
  readonly shifts: ShiftService
  readonly companyUsers: CompanyUsersService
  readonly connectivity: ConnectivityService
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
  const licenseMetadata = new LicenseMetadataRepository(database)
  const bootstrapState = new BootstrapStateRepository(database)
  const bootstrapSnapshot = new BootstrapSnapshotRepository(database)
  const catalogRepository = new CatalogRepository(database)
  const syncQueue = new SyncQueueRepository(database)
  const syncConflicts = new SyncConflictRepository(database)
  const deviceIdentity = new DeviceIdentityService(deviceIdentityRepository, {
    deviceName: hostname(),
    platform: platform(),
    osVersion: release(),
    appVersion: app.getVersion()
  })
  const secureStorage = new SecureStorageService(secureSecrets, safeStorage)
  const session = new SessionService(sessionMetadata, secureStorage)
  let commercialAccessPublisher: CommercialAccessPublisher | null = null
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
  const catalog = new CatalogService(catalogRepository, catalogReadAccess, catalogClock)
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
  const shifts = new ShiftService(apiClient, commercialAccess, shiftPermissions)
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
    shifts,
    companyUsers,
    connectivity,
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
      connectivity.shutdown()
      apiClient.shutdown()
      closeDatabase(database)
    }
  }
}
