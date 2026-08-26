import { foundationMigration } from './0001_foundation'
import { activationAuthBootstrapMigration } from './0002_activation_auth_bootstrap'
import { sellableCatalogMigration } from './0003_sellable_catalog'
import { catalogSnapshotIntegrityMigration } from './0004_catalog_snapshot_integrity'

export const databaseMigrations = [
  foundationMigration,
  activationAuthBootstrapMigration,
  sellableCatalogMigration,
  catalogSnapshotIntegrityMigration
] as const
