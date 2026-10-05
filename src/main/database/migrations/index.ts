import { foundationMigration } from './0001_foundation'
import { activationAuthBootstrapMigration } from './0002_activation_auth_bootstrap'
import { sellableCatalogMigration } from './0003_sellable_catalog'
import { catalogSnapshotIntegrityMigration } from './0004_catalog_snapshot_integrity'
import { currencyContractMigration } from './0005_currency_contract'
import { shiftObservationMigration } from './0006_shift_observation'
import { localSalePersistenceMigration } from './0007_local_sale_persistence'
import { bootstrapStockAllocationsMigration } from './0008_bootstrap_stock_allocations'
import { allocationLifecycleReconciliationMigration } from './0009_allocation_lifecycle_reconciliation'
import { allocationRecoveryMigration } from './0010_allocation_recovery'
import { offlineStockPreparationMigration } from './0011_offline_stock_preparation'
import { offlineSalePolicyMigration } from './0012_offline_sale_policy'
import { dispositionDiscoveryMigration } from './0013_disposition_discovery'
import { localRefundsMigration } from './0014_local_refunds'
import { receiptPrintingMigration } from './0015_receipt_printing'
import { allocationDispatchEvidenceMigration } from './0016_allocation_dispatch_evidence'
import { offlineSaleAuthorityWarehouseMigration } from './0017_offline_sale_authority_warehouse'
import { productImagesMigration } from './0018_product_images'
import { companyBrandingMigration } from './0019_company_branding'
import { bootstrapCapabilitiesMigration } from './0020_bootstrap_capabilities'
import { quickCreateMigration } from './0021_quick_create'
import { mixedTaxMigration } from './0022_mixed_tax'
import { userPreferencesMigration } from './0023_user_preferences'
import { fiscalReceiptsMigration } from './0024_fiscal_receipts'
import { autoPrintMigration } from './0025_auto_print'
import { receiptSnapshotsMigration } from './0030_receipt_snapshots'
import { receiptSnapshotV2Migration } from './0031_receipt_snapshot_v2'
import { catalogOffersMigration } from './0032_catalog_offers'

export const databaseMigrations = [
  foundationMigration,
  activationAuthBootstrapMigration,
  sellableCatalogMigration,
  catalogSnapshotIntegrityMigration,
  currencyContractMigration,
  shiftObservationMigration,
  localSalePersistenceMigration,
  bootstrapStockAllocationsMigration,
  allocationLifecycleReconciliationMigration,
  allocationRecoveryMigration,
  offlineStockPreparationMigration,
  offlineSalePolicyMigration,
  dispositionDiscoveryMigration,
  localRefundsMigration,
  receiptPrintingMigration,
  allocationDispatchEvidenceMigration,
  offlineSaleAuthorityWarehouseMigration,
  productImagesMigration,
  companyBrandingMigration,
  bootstrapCapabilitiesMigration,
  quickCreateMigration,
  mixedTaxMigration,
  userPreferencesMigration,
  fiscalReceiptsMigration,
  autoPrintMigration,
  receiptSnapshotsMigration,
  receiptSnapshotV2Migration,
  catalogOffersMigration
] as const
