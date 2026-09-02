import { strict as assert } from 'node:assert'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { AppSettingsRepository } from '../../../src/main/repositories/appSettings.repository'
import { BootstrapSnapshotRepository } from '../../../src/main/repositories/bootstrapSnapshot.repository'
import { BootstrapStateRepository } from '../../../src/main/repositories/bootstrapState.repository'
import { CatalogRepository } from '../../../src/main/repositories/catalog.repository'
import { SqliteDeviceIdentityRepository } from '../../../src/main/repositories/deviceIdentity.repository'
import { DeviceRegistrationRepository } from '../../../src/main/repositories/deviceRegistration.repository'
import { LicenseMetadataRepository } from '../../../src/main/repositories/licenseMetadata.repository'
import { LocalSaleRepository } from '../../../src/main/repositories/localSale.repository'
import { LocalStockRepository } from '../../../src/main/repositories/localStock.repository'
import { SaleAttemptRepository } from '../../../src/main/repositories/saleAttempt.repository'
import { SecureSecretsRepository } from '../../../src/main/repositories/secureSecrets.repository'
import { SessionEpochRepository } from '../../../src/main/repositories/sessionEpoch.repository'
import { SqliteSessionMetadataRepository } from '../../../src/main/repositories/sessionMetadata.repository'
import { ShiftObservationRepository } from '../../../src/main/repositories/shiftObservation.repository'
import { StockAllocationRepository } from '../../../src/main/repositories/stockAllocation.repository'
import { SyncQueueRepository } from '../../../src/main/repositories/syncQueue.repository'

export interface RealRepositories {
  readonly appSettings: AppSettingsRepository
  readonly bootstrapSnapshot: BootstrapSnapshotRepository
  readonly bootstrapState: BootstrapStateRepository
  readonly catalog: CatalogRepository
  readonly deviceIdentity: SqliteDeviceIdentityRepository
  readonly deviceRegistration: DeviceRegistrationRepository
  readonly licenseMetadata: LicenseMetadataRepository
  readonly localSale: LocalSaleRepository
  readonly localStock: LocalStockRepository
  readonly saleAttempts: SaleAttemptRepository
  readonly secureSecrets: SecureSecretsRepository
  readonly sessionEpoch: SessionEpochRepository
  readonly sessionMetadata: SqliteSessionMetadataRepository
  readonly shiftObservations: ShiftObservationRepository
  readonly stockAllocations: StockAllocationRepository
  readonly syncQueue: SyncQueueRepository
}

export function realRepositories(database: SqliteDatabase): RealRepositories {
  const stockAllocations = new StockAllocationRepository(database)
  const repositories = {
    appSettings: new AppSettingsRepository(database),
    bootstrapSnapshot: new BootstrapSnapshotRepository(database, stockAllocations),
    bootstrapState: new BootstrapStateRepository(database),
    catalog: new CatalogRepository(database),
    deviceIdentity: new SqliteDeviceIdentityRepository(database),
    deviceRegistration: new DeviceRegistrationRepository(database),
    licenseMetadata: new LicenseMetadataRepository(database),
    localSale: new LocalSaleRepository(database),
    localStock: new LocalStockRepository(database),
    saleAttempts: new SaleAttemptRepository(database),
    secureSecrets: new SecureSecretsRepository(database),
    sessionEpoch: new SessionEpochRepository(database),
    sessionMetadata: new SqliteSessionMetadataRepository(database),
    shiftObservations: new ShiftObservationRepository(database),
    stockAllocations,
    syncQueue: new SyncQueueRepository(database)
  }

  assert.ok(repositories.appSettings instanceof AppSettingsRepository)
  assert.ok(repositories.bootstrapSnapshot instanceof BootstrapSnapshotRepository)
  assert.ok(repositories.bootstrapState instanceof BootstrapStateRepository)
  assert.ok(repositories.catalog instanceof CatalogRepository)
  assert.ok(repositories.deviceIdentity instanceof SqliteDeviceIdentityRepository)
  assert.ok(repositories.deviceRegistration instanceof DeviceRegistrationRepository)
  assert.ok(repositories.licenseMetadata instanceof LicenseMetadataRepository)
  assert.ok(repositories.localSale instanceof LocalSaleRepository)
  assert.ok(repositories.localStock instanceof LocalStockRepository)
  assert.ok(repositories.saleAttempts instanceof SaleAttemptRepository)
  assert.ok(repositories.secureSecrets instanceof SecureSecretsRepository)
  assert.ok(repositories.sessionEpoch instanceof SessionEpochRepository)
  assert.ok(repositories.sessionMetadata instanceof SqliteSessionMetadataRepository)
  assert.ok(repositories.shiftObservations instanceof ShiftObservationRepository)
  assert.ok(repositories.stockAllocations instanceof StockAllocationRepository)
  assert.ok(repositories.syncQueue instanceof SyncQueueRepository)

  return repositories
}
