import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 1 — what the cached bootstrap context may authorize, and for whom.
 *
 * Additive only.
 *
 * - `bootstrap_capabilities` — server capabilities a bootstrap negotiated and confirmed (for example
 *   `quick_create`). Replaced with every persisted bootstrap; ABSENT means the server did not
 *   advertise the capability (an older backend), never "allowed".
 * - `bootstrap_snapshot_owner` — the signed-in user whose bootstrap filled `bootstrap_permissions`.
 *   The permission cache is global; main only trusts it for that same user, so a snapshot left by
 *   another cashier can never authorize an offline action.
 */
export const bootstrapCapabilitiesMigration: DatabaseMigration = {
  version: 20,
  name: 'bootstrap_capabilities',
  up(database) {
    database.exec(`
      -- IF NOT EXISTS: a separate branch's receipt-snapshot migration (0030) creates this exact table
      -- with the same statement, so whichever runs first, the other is a no-op.
      CREATE TABLE IF NOT EXISTS bootstrap_capabilities (
        capability  TEXT PRIMARY KEY CHECK (length(capability) BETWEEN 1 AND 64),
        version     INTEGER NOT NULL CHECK (version >= 1),
        updated_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE bootstrap_snapshot_owner (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        user_uuid   TEXT CHECK (user_uuid IS NULL OR length(user_uuid) = 36),
        updated_at  TEXT NOT NULL
      ) STRICT;
    `)
  }
}
