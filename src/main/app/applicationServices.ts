import { app, safeStorage } from 'electron'
import { hostname, platform, release } from 'os'
import { runtimeInfoSchema, type RuntimeInfo } from '@shared/contracts/system.contract'
import { loadRuntimeConfig, type RuntimeConfig } from '../config/runtimeConfig'
import { closeDatabase, openDatabase, type SqliteDatabase } from '../database/connection'
import { databaseMigrations } from '../database/migrations'
import { runMigrations } from '../database/migrator'
import { DesktopApiClient } from '../http/desktopApiClient'
import { AppSettingsRepository } from '../repositories/appSettings.repository'
import { BootstrapStateRepository } from '../repositories/bootstrapState.repository'
import { SqliteDeviceIdentityRepository } from '../repositories/deviceIdentity.repository'
import { LicenseMetadataRepository } from '../repositories/licenseMetadata.repository'
import { SecureSecretsRepository } from '../repositories/secureSecrets.repository'
import { SqliteSessionMetadataRepository } from '../repositories/sessionMetadata.repository'
import { SyncConflictRepository } from '../repositories/syncConflict.repository'
import { SyncQueueRepository } from '../repositories/syncQueue.repository'
import { DeviceIdentityService } from '../services/deviceIdentity.service'
import { SecureStorageService } from '../services/secureStorage.service'
import { SessionService } from '../services/session.service'

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
  const secureSecrets = new SecureSecretsRepository(database)
  const sessionMetadata = new SqliteSessionMetadataRepository(database)
  const licenseMetadata = new LicenseMetadataRepository(database)
  const bootstrapState = new BootstrapStateRepository(database)
  const syncQueue = new SyncQueueRepository(database)
  const syncConflicts = new SyncConflictRepository(database)
  const deviceIdentity = new DeviceIdentityService(deviceIdentityRepository, {
    deviceName: hostname(),
    platform: platform(),
    osVersion: release(),
    appVersion: app.getVersion()
  })
  const secureStorage = new SecureStorageService(secureSecrets, safeStorage)
  const session = new SessionService(sessionMetadata)

  deviceIdentity.getOrCreate()

  const apiClient = new DesktopApiClient({
    apiOrigin: runtimeConfig.apiOrigin,
    getAccessToken: () => secureStorage.getSecret('desktop_access_token'),
    getDeviceUuid: () => deviceIdentity.getOrCreate().deviceUuid
  })

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
      apiClient.shutdown()
      closeDatabase(database)
    }
  }
}
