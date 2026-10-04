import { strict as assert } from 'node:assert'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { AppSettingsRepository } from '../../../src/main/repositories/appSettings.repository'
import { AllocationDispatchRepository } from '../../../src/main/repositories/allocationDispatch.repository'
import { AllocationRecoveryRepository } from '../../../src/main/repositories/allocationRecovery.repository'
import { BootstrapSnapshotRepository } from '../../../src/main/repositories/bootstrapSnapshot.repository'
import { BootstrapStateRepository } from '../../../src/main/repositories/bootstrapState.repository'
import { CatalogRepository } from '../../../src/main/repositories/catalog.repository'
import { SqliteDeviceIdentityRepository } from '../../../src/main/repositories/deviceIdentity.repository'
import { DeviceRegistrationRepository } from '../../../src/main/repositories/deviceRegistration.repository'
import { LicenseMetadataRepository } from '../../../src/main/repositories/licenseMetadata.repository'
import { LocalSaleRepository } from '../../../src/main/repositories/localSale.repository'
import { LocalRefundRepository } from '../../../src/main/repositories/localRefund.repository'
import { LocalStockRepository } from '../../../src/main/repositories/localStock.repository'
import { PreparationRepository } from '../../../src/main/repositories/preparation.repository'
import { ProductImageRepository } from '../../../src/main/repositories/productImage.repository'
import { CompanyBrandingRepository } from '../../../src/main/repositories/companyBranding.repository'
import { ReceiptContextRepository } from '../../../src/main/repositories/receiptContext.repository'
import { ReceiptProfileRepository } from '../../../src/main/repositories/receiptProfile.repository'
import { SaleAttemptRepository } from '../../../src/main/repositories/saleAttempt.repository'
import { SecureSecretsRepository } from '../../../src/main/repositories/secureSecrets.repository'
import { SessionEpochRepository } from '../../../src/main/repositories/sessionEpoch.repository'
import { SqliteSessionMetadataRepository } from '../../../src/main/repositories/sessionMetadata.repository'
import { ShiftObservationRepository } from '../../../src/main/repositories/shiftObservation.repository'
import { StockAllocationRepository } from '../../../src/main/repositories/stockAllocation.repository'
import { OfflineSaleAuthorityRepository } from '../../../src/main/repositories/offlineSaleAuthority.repository'
import { SyncConflictRepository } from '../../../src/main/repositories/syncConflict.repository'
import { SyncQueueRepository } from '../../../src/main/repositories/syncQueue.repository'
import { UploadDependencyRepository } from '../../../src/main/repositories/uploadDependency.repository'
import { AllocationReconciliationService } from '../../../src/main/services/allocationReconciliation.service'

export interface RealRepositories {
  readonly appSettings: AppSettingsRepository
  readonly allocationDispatches: AllocationDispatchRepository
  readonly allocationRecoveries: AllocationRecoveryRepository
  readonly bootstrapSnapshot: BootstrapSnapshotRepository
  readonly bootstrapState: BootstrapStateRepository
  readonly catalog: CatalogRepository
  readonly deviceIdentity: SqliteDeviceIdentityRepository
  readonly deviceRegistration: DeviceRegistrationRepository
  readonly licenseMetadata: LicenseMetadataRepository
  readonly localSale: LocalSaleRepository
  readonly localRefunds: LocalRefundRepository
  readonly localStock: LocalStockRepository
  /** PS4: the stored server-issued offline-sale authority. */
  readonly offlineSaleAuthorities: OfflineSaleAuthorityRepository
  /** CP3: durable preparation cycles and operations. */
  readonly preparation: PreparationRepository
  /** Owner UX plan P8: product image references and verified bytes. */
  readonly productImages: ProductImageRepository
  /** Owner UX plan P9: the company identity and its logo. */
  readonly companyBranding: CompanyBrandingRepository
  /** Receipt-printing plan §D-11: the company receipt-profile mirror. */
  readonly receiptProfile: ReceiptProfileRepository
  /** Receipt-printing plan §D-2/§D-8: the immutable receipt context (issuer/cashier/profile). */
  readonly receiptContext: ReceiptContextRepository
  readonly saleAttempts: SaleAttemptRepository
  readonly secureSecrets: SecureSecretsRepository
  readonly sessionEpoch: SessionEpochRepository
  readonly sessionMetadata: SqliteSessionMetadataRepository
  readonly shiftObservations: ShiftObservationRepository
  readonly stockAllocations: StockAllocationRepository
  readonly syncQueue: SyncQueueRepository
  readonly syncConflicts: SyncConflictRepository
  /** Rev 4 §10.3: allocation-chain upload dependencies. */
  readonly uploadDependencies: UploadDependencyRepository
  /** BH-04B-3: wired exactly as production wires it, so suites exercise the real reconciliation. */
  readonly allocationReconciliation: AllocationReconciliationService
}

/**
 * CP3: the preparation repository takes an explicit clock, so a suite can pin timestamps without
 * reaching for fake timers. It defaults to the real clock, exactly as production wires it.
 */
export function realRepositories(
  database: SqliteDatabase,
  now: () => string = () => new Date().toISOString()
): RealRepositories {
  const stockAllocations = new StockAllocationRepository(database)
  const allocationRecoveries = new AllocationRecoveryRepository(database, stockAllocations)
  const allocationReconciliation = new AllocationReconciliationService({
    stockAllocations,
    allocationRecoveries
  })
  const productImages = new ProductImageRepository(database)
  const companyBranding = new CompanyBrandingRepository(database)
  const repositories = {
    appSettings: new AppSettingsRepository(database),
    allocationDispatches: new AllocationDispatchRepository(database),
    allocationRecoveries,
    bootstrapSnapshot: new BootstrapSnapshotRepository(
      database,
      stockAllocations,
      allocationReconciliation,
      productImages,
      companyBranding
    ),
    bootstrapState: new BootstrapStateRepository(database),
    catalog: new CatalogRepository(database),
    deviceIdentity: new SqliteDeviceIdentityRepository(database),
    deviceRegistration: new DeviceRegistrationRepository(database),
    licenseMetadata: new LicenseMetadataRepository(database),
    localSale: new LocalSaleRepository(database),
    localRefunds: new LocalRefundRepository(database),
    localStock: new LocalStockRepository(database),
    offlineSaleAuthorities: new OfflineSaleAuthorityRepository(database),
    preparation: new PreparationRepository(database, now),
    productImages,
    companyBranding,
    receiptProfile: new ReceiptProfileRepository(database),
    receiptContext: new ReceiptContextRepository(database),
    saleAttempts: new SaleAttemptRepository(database),
    secureSecrets: new SecureSecretsRepository(database),
    sessionEpoch: new SessionEpochRepository(database),
    sessionMetadata: new SqliteSessionMetadataRepository(database),
    shiftObservations: new ShiftObservationRepository(database),
    stockAllocations,
    syncQueue: new SyncQueueRepository(database),
    syncConflicts: new SyncConflictRepository(database),
    uploadDependencies: new UploadDependencyRepository(database),
    allocationReconciliation
  }

  assert.ok(repositories.appSettings instanceof AppSettingsRepository)
  assert.ok(repositories.allocationDispatches instanceof AllocationDispatchRepository)
  assert.ok(repositories.allocationRecoveries instanceof AllocationRecoveryRepository)
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
  assert.ok(repositories.preparation instanceof PreparationRepository)
  assert.ok(repositories.receiptProfile instanceof ReceiptProfileRepository)
  assert.ok(repositories.receiptContext instanceof ReceiptContextRepository)
  assert.ok(repositories.stockAllocations instanceof StockAllocationRepository)
  assert.ok(repositories.syncQueue instanceof SyncQueueRepository)
  assert.ok(repositories.uploadDependencies instanceof UploadDependencyRepository)

  return repositories
}
