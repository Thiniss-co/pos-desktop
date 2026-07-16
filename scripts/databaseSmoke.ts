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
  'license_state_metadata',
  'bootstrap_state',
  'sync_queue',
  'sync_conflicts'
]

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

  console.log('Electron SQLite migration smoke test passed')
} finally {
  closeDatabase(database)
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
