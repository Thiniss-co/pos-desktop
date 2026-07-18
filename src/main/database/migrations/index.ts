import { foundationMigration } from './0001_foundation'
import { activationAuthBootstrapMigration } from './0002_activation_auth_bootstrap'

export const databaseMigrations = [foundationMigration, activationAuthBootstrapMigration] as const
