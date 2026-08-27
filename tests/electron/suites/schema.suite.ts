import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { databaseTest } from '../support/sandbox'
import {
  assertDefaultDatabasePathIsUnavailable,
  applyAllTestMigrations,
  openExistingTestDatabase,
  openPhaseTwoTestDatabase,
  openTestDatabase
} from '../support/openTestDatabase'

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

databaseTest(
  'schema migrates an empty file, applies every table and preserves pragmas',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    const indexes = (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)

    for (const table of expectedTables) {
      ok(tables.includes(table), `missing table ${table}`)
    }
    equal(tables.includes('product_prices'), false)
    deepEqual(indexes, [
      'idx_catalog_categories_active_name',
      'idx_catalog_customers_active_name',
      'idx_catalog_customers_search_name',
      'idx_catalog_customers_search_phone',
      'idx_catalog_product_barcodes_lookup',
      'idx_catalog_products_barcode',
      'idx_catalog_products_browse',
      'idx_catalog_products_search_name',
      'idx_catalog_products_search_sku',
      'idx_catalog_stock_items_product',
      'idx_catalog_stock_items_warehouse',
      'idx_product_barcodes_barcode',
      'idx_product_barcodes_product_id',
      'idx_stock_items_product_id',
      'idx_stock_items_warehouse_id'
    ])
    equal(
      (
        database
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_queue'")
          .get() as { sql: string }
      ).sql.includes(
        "CHECK (state IN ('pending', 'uploading', 'synced', 'retryable_error', 'conflict', 'rejected'))"
      ),
      true
    )

    closeDatabase(database)
  }
)

databaseTest(
  'schema migration reruns are idempotent and a closed file reopens intact',
  (sandbox) => {
    const first = openTestDatabase(sandbox)
    first
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('schema.test', 'ok', '2026-01-01T00:00:00Z')
    closeDatabase(first)

    const reopened = openExistingTestDatabase(sandbox)
    const applied = reopened
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    const setting = reopened
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('schema.test') as { value: string }

    deepEqual(
      applied.map((row) => row.version),
      databaseMigrations.map((migration) => migration.version)
    )
    equal(setting.value, 'ok')
    closeDatabase(reopened)
  }
)

databaseTest(
  'an existing Phase 2 database migrates additively with its state intact',
  (sandbox) => {
    const database = openPhaseTwoTestDatabase(sandbox)
    database
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('migration.canary', 'preserved', '2026-01-01T00:00:00Z')
    applyAllTestMigrations(database)

    equal(
      (
        database
          .prepare('SELECT value FROM app_settings WHERE key = ?')
          .get('migration.canary') as {
          value: string
        }
      ).value,
      'preserved'
    )
    equal(
      (
        database.prepare('SELECT COUNT(*) AS total FROM catalog_metadata').get() as {
          total: number
        }
      ).total,
      0,
      'old bootstrap data must not fabricate a current sellable catalog'
    )
    closeDatabase(database)
  }
)

databaseTest('the Electron Node harness cannot resolve the production database path', () => {
  assertDefaultDatabasePathIsUnavailable()
})
