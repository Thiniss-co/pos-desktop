import type { SqliteDatabase } from './connection'

export interface DatabaseMigration {
  readonly version: number
  readonly name: string
  up(database: SqliteDatabase): void
}

interface AppliedMigrationRow {
  readonly version: number
}

export function runMigrations(
  database: SqliteDatabase,
  migrations: readonly DatabaseMigration[]
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const appliedVersions = new Set(
    (database.prepare('SELECT version FROM schema_migrations').all() as AppliedMigrationRow[]).map(
      (migration) => migration.version
    )
  )

  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (appliedVersions.has(migration.version)) {
      continue
    }

    database.transaction(() => {
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
    })()
  }
}
