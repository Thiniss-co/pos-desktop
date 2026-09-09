import type { SqliteDatabase } from './connection'

export interface DatabaseMigration {
  readonly version: number
  readonly name: string
  up(database: SqliteDatabase): void
  /**
   * True only for a migration that rebuilds a table other tables hold a foreign key to (SQLite has
   * no `ALTER TABLE ... DROP CONSTRAINT`, so changing a CHECK requires create-copy-drop-rename).
   *
   * This is exactly SQLite's own documented procedure for this category of schema change
   * (sqlite.org/lang_altertable.html §8, "Making Other Kinds Of Table Schema Changes"): disable
   * `foreign_keys` before starting the transaction, rebuild, run `PRAGMA foreign_key_check` before
   * commit, commit, then re-enable `foreign_keys`. Two things make that specific order necessary,
   * both confirmed against a minimal repro rather than assumed:
   *
   * - `PRAGMA foreign_keys = OFF` is a documented no-op once a transaction is already open (checked
   *   directly: the pragma's own read-back value stays `1`/ON), so it must be toggled *before* this
   *   migration's transaction opens — the one moment it can — and restored *after* it closes.
   * - `PRAGMA defer_foreign_keys = ON` is not a working substitute. It does let `DROP TABLE` of a
   *   referenced parent succeed instead of failing immediately (the violation from the implicit
   *   `DELETE`, sqlite.org/foreignkeys.html §5, is deferred to commit) — but in the specific
   *   create/copy/drop/rename sequence a rebuild needs, the deferred violation is not reconciled by
   *   the later rename: `COMMIT` still fails with `FOREIGN KEY constraint failed` even after a
   *   fully-populated replacement table has been renamed back into place and `PRAGMA
   *   foreign_key_check` reports zero violations moments earlier, mid-transaction.
   *
   * The migration itself is the actual safety gate this leaves in place: with enforcement off for
   * its duration, it must run its own `PRAGMA foreign_key_check` before returning and throw if it
   * finds anything, so a real orphan still rolls back this migration's transaction instead of
   * committing a damaged schema.
   */
  readonly rebuildsForeignKeyReferencedTable?: boolean
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

    const run = (): void => {
      database.transaction(() => {
        migration.up(database)
        database
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString())
      })()
    }

    if (!migration.rebuildsForeignKeyReferencedTable) {
      run()
      continue
    }

    // `foreign_keys` toggles only take effect with no transaction open, so this happens strictly
    // before/after the migration's own transaction — never inside it. Per-migration atomicity is
    // unchanged: a failure still rolls back exactly this migration's transaction, and the pragma is
    // restored in a `finally` so a throw here never leaves later migrations running unenforced.
    database.pragma('foreign_keys = OFF')
    try {
      run()
    } finally {
      database.pragma('foreign_keys = ON')
    }
  }
}
