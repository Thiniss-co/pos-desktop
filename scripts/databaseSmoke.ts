import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, openDatabase } from '../src/main/database/connection'
import { databaseMigrations } from '../src/main/database/migrations'
import { runMigrations } from '../src/main/database/migrator'

const expectedTables = [
  'schema_migrations',
  'app_settings',
  'device_identity',
  'secure_secrets',
  'auth_session_metadata',
  'session_epoch',
  'shift_observation',
  'license_state_metadata',
  'bootstrap_state',
  'sync_queue',
  'sync_conflicts',
  'device_registration',
  'bootstrap_company',
  'bootstrap_branch',
  'bootstrap_warehouse',
  'bootstrap_subscription',
  'bootstrap_features',
  'bootstrap_limits',
  'bootstrap_permissions',
  'bootstrap_role',
  'categories',
  'products',
  'product_barcodes',
  'stock_items',
  'taxes',
  'payment_methods',
  'customers',
  'catalog_metadata',
  'catalog_categories',
  'catalog_products',
  'catalog_product_barcodes',
  'catalog_stock_items'
]

const expectedBootstrapStateColumns = ['snapshot_version', 'server_time', 'counts_json']
const expectedLicenseMetadataColumns = ['details_json']

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pos-desktop-database-smoke-'))
const database = openDatabase({ databasePath: join(temporaryDirectory, 'foundation.sqlite') })

try {
  runMigrations(database, databaseMigrations)
  runMigrations(database, databaseMigrations)

  const tableNames = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((table) => table.name)
  )

  for (const tableName of expectedTables) {
    if (!tableNames.has(tableName)) {
      throw new Error(`Database smoke test is missing ${tableName}`)
    }
  }

  if (tableNames.has('product_prices')) {
    throw new Error('Database smoke test found the retired product_prices table')
  }

  function columnNames(table: string): Set<string> {
    return new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
  }

  const bootstrapStateColumns = columnNames('bootstrap_state')
  for (const columnName of expectedBootstrapStateColumns) {
    if (!bootstrapStateColumns.has(columnName)) {
      throw new Error(`Database smoke test is missing bootstrap_state.${columnName}`)
    }
  }

  const licenseMetadataColumns = columnNames('license_state_metadata')
  for (const columnName of expectedLicenseMetadataColumns) {
    if (!licenseMetadataColumns.has(columnName)) {
      throw new Error(`Database smoke test is missing license_state_metadata.${columnName}`)
    }
  }

  // Exercise a representative write/read against a Phase 2 table to prove the schema is usable,
  // not just present.
  database
    .prepare(
      'INSERT INTO device_registration (id, server_device_id, status, last_seen_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    )
    .run('smoke-server-device-id', 'active', null, new Date().toISOString())

  const registration = database
    .prepare('SELECT server_device_id, status FROM device_registration WHERE id = 1')
    .get() as { server_device_id: string; status: string } | undefined

  if (registration?.server_device_id !== 'smoke-server-device-id') {
    throw new Error('Database smoke test could not round-trip device_registration')
  }

  console.log('Electron SQLite migration smoke test passed')
} finally {
  closeDatabase(database)
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
