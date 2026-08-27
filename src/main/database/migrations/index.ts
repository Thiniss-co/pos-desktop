import { foundationMigration } from './0001_foundation'
import { activationAuthBootstrapMigration } from './0002_activation_auth_bootstrap'
import { sellableCatalogMigration } from './0003_sellable_catalog'
import { catalogSnapshotIntegrityMigration } from './0004_catalog_snapshot_integrity'
import { currencyContractMigration } from './0005_currency_contract'
import { shiftObservationMigration } from './0006_shift_observation'

export const databaseMigrations = [
  foundationMigration,
  activationAuthBootstrapMigration,
  sellableCatalogMigration,
  catalogSnapshotIntegrityMigration,
  currencyContractMigration,
  shiftObservationMigration
] as const
