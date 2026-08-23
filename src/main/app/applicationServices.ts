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
import { CompanyUsersService } from '../services/companyUsers.service'
import { CommercialAccessService } from '../services/commercialAccess.service'
import { DeviceIdentityService } from '../services/deviceIdentity.service'
import { LicenseService } from '../services/license.service'
import { SecureStorageService } from '../services/secureStorage.service'
import { SessionService } from '../services/session.service'
import { ConnectivityService } from '../services/connectivity.service'
import { broadcastConnectivityChanged } from '../ipc/connectivity.ipc'

export interface ApplicationServices {
  readonly runtimeConfig: RuntimeConfig
  readonly database: SqliteDatabase
  readonly appSettings: AppSettingsRepository
  readonly deviceIdentity: DeviceIdentityService
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
  readonly bootstrap: BootstrapService
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
  const connectivity = new ConnectivityService({
    apiOrigin: runtimeConfig.apiOrigin,
    isOnline: () => net.isOnline(),
    fetchImplementation: (input, init) => net.fetch(input, init),
    onResume: (listener) => {
      powerMonitor.on('resume', listener)
      return () => powerMonitor.off('resume', listener)
    },
    onChange: broadcastConnectivityChanged
  })

  deviceIdentity.getOrCreate()

  const apiClient = new DesktopApiClient({
    apiOrigin: runtimeConfig.apiOrigin,
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
  const commercialAccess = new CommercialAccessService(
    session,
    licenseMetadata,
    bootstrapSnapshot,
    appSettings
  )
  const bootstrap = new BootstrapService(
    apiClient,
    deviceIdentityRepository,
    commercialAccess,
    bootstrapState,
    bootstrapSnapshot
  )
  const companyUsers = new CompanyUsersService(apiClient, bootstrapSnapshot)

  return {
    runtimeConfig,
    database,
    appSettings,
    deviceIdentity,
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
    bootstrap,
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
