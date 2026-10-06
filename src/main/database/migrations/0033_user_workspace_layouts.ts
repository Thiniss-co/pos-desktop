import type { DatabaseMigration } from '../migrator'

/**
 * POS workspace — the selling-screen layout per company + user + workstation.
 *
 * Presentation only: a bounded, versioned JSON object (preset, cart side and share, density, product
 * view, collapsed browser, section order) validated by `posWorkspace.contract.ts` on every write and
 * normalized on every read. It never holds cart, sale, customer or credential data, and it is not
 * synchronized. The owner columns always come from the main-process session, never the renderer.
 */
export const userWorkspaceLayoutsMigration: DatabaseMigration = {
  version: 33,
  name: 'user_workspace_layouts',
  up(database): void {
    database.exec(`
      CREATE TABLE user_workspace_layouts (
        company_uuid   TEXT NOT NULL CHECK (length(company_uuid) > 0),
        user_uuid      TEXT NOT NULL CHECK (length(user_uuid) > 0),
        device_uuid    TEXT NOT NULL CHECK (length(device_uuid) > 0),
        layout_json    TEXT NOT NULL CHECK (
          json_valid(layout_json) AND length(CAST(layout_json AS BLOB)) <= 2048
        ),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (company_uuid, user_uuid, device_uuid)
      ) STRICT;
    `)
  }
}
