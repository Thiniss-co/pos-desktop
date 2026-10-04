import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 5 — per-user preferences on this workstation.
 *
 * Keyed by (company, user, key), so two cashiers sharing a register each keep their own choice.
 * Only a closed set of boolean keys exists; the identity always comes from the main-process
 * session, never from the renderer.
 *
 * - `ui.touchMode`       — touch layout (absent = off).
 * - `printing.autoPrint` — automatic receipt printing after a sale (absent = ON; Stage 7, D3).
 */
export const userPreferencesMigration: DatabaseMigration = {
  version: 23,
  name: 'user_preferences',
  up(database): void {
    database.exec(`
      CREATE TABLE user_preferences (
        company_uuid TEXT NOT NULL,
        user_uuid    TEXT NOT NULL,
        key          TEXT NOT NULL CHECK (key IN ('ui.touchMode', 'printing.autoPrint')),
        value        TEXT NOT NULL CHECK (value IN ('true', 'false')),
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (company_uuid, user_uuid, key)
      ) STRICT;
    `)
  }
}
