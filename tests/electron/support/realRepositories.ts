import { strict as assert } from 'node:assert'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { AppSettingsRepository } from '../../../src/main/repositories/appSettings.repository'
import { BootstrapSnapshotRepository } from '../../../src/main/repositories/bootstrapSnapshot.repository'
import { BootstrapStateRepository } from '../../../src/main/repositories/bootstrapState.repository'
import { SqliteDeviceIdentityRepository } from '../../../src/main/repositories/deviceIdentity.repository'
import { DeviceRegistrationRepository } from '../../../src/main/repositories/deviceRegistration.repository'
import { LicenseMetadataRepository } from '../../../src/main/repositories/licenseMetadata.repository'
import { SecureSecretsRepository } from '../../../src/main/repositories/secureSecrets.repository'
import { SqliteSessionMetadataRepository } from '../../../src/main/repositories/sessionMetadata.repository'
import { SyncQueueRepository } from '../../../src/main/repositories/syncQueue.repository'

export interface RealRepositories {
  readonly appSettings: AppSettingsRepository
  readonly bootstrapSnapshot: BootstrapSnapshotRepository
  readonly bootstrapState: BootstrapStateRepository
  readonly deviceIdentity: SqliteDeviceIdentityRepository
  readonly deviceRegistration: DeviceRegistrationRepository
  readonly licenseMetadata: LicenseMetadataRepository
  readonly secureSecrets: SecureSecretsRepository
  readonly sessionMetadata: SqliteSessionMetadataRepository
  readonly syncQueue: SyncQueueRepository
}

export function realRepositories(database: SqliteDatabase): RealRepositories {
  const repositories = {
    appSettings: new AppSettingsRepository(database),
    bootstrapSnapshot: new BootstrapSnapshotRepository(database),
    bootstrapState: new BootstrapStateRepository(database),
    deviceIdentity: new SqliteDeviceIdentityRepository(database),
    deviceRegistration: new DeviceRegistrationRepository(database),
    licenseMetadata: new LicenseMetadataRepository(database),
    secureSecrets: new SecureSecretsRepository(database),
    sessionMetadata: new SqliteSessionMetadataRepository(database),
    syncQueue: new SyncQueueRepository(database)
  }

  assert.ok(repositories.appSettings instanceof AppSettingsRepository)
  assert.ok(repositories.bootstrapSnapshot instanceof BootstrapSnapshotRepository)
  assert.ok(repositories.bootstrapState instanceof BootstrapStateRepository)
  assert.ok(repositories.deviceIdentity instanceof SqliteDeviceIdentityRepository)
  assert.ok(repositories.deviceRegistration instanceof DeviceRegistrationRepository)
  assert.ok(repositories.licenseMetadata instanceof LicenseMetadataRepository)
  assert.ok(repositories.secureSecrets instanceof SecureSecretsRepository)
  assert.ok(repositories.sessionMetadata instanceof SqliteSessionMetadataRepository)
  assert.ok(repositories.syncQueue instanceof SyncQueueRepository)

  return repositories
}
