import type { DatabaseMigration } from '../migrator'

/**
 * Rev 4 §6.4 — warehouse-bound offline-sale authorities.
 *
 * Additive only.
 *
 * - `offline_sale_authorities.warehouse_uuid` — the warehouse the server issued the authority for,
 *   as published by the negotiated v2 representation. Existing rows stay NULL: the owning warehouse
 *   is NEVER inferred from the device's current assignment, so a NULL row is simply never selected
 *   for a new sale. It is kept because committed invoices reference it.
 * - `offline_sale_authority_conflicts` — append-only evidence when the server publishes bytes under
 *   a known authority UUID that disagree with what is stored. The stored row is never overwritten.
 */
export const offlineSaleAuthorityWarehouseMigration: DatabaseMigration = {
  version: 17,
  name: 'offline_sale_authority_warehouse',
  up(database) {
    database.exec(`
      ALTER TABLE offline_sale_authorities ADD COLUMN warehouse_uuid TEXT
        CHECK (warehouse_uuid IS NULL OR length(warehouse_uuid) = 36);

      CREATE INDEX idx_offline_sale_authorities_warehouse
        ON offline_sale_authorities(company_uuid, device_uuid, warehouse_uuid, not_after);

      CREATE TABLE offline_sale_authority_conflicts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        authority_uuid   TEXT NOT NULL,
        reason           TEXT NOT NULL CHECK (reason IN ('immutable_field_mismatch','warehouse_mismatch')),
        published_json   TEXT NOT NULL,
        recorded_at      TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER offline_sale_authority_conflicts_no_update
        BEFORE UPDATE ON offline_sale_authority_conflicts
        BEGIN SELECT RAISE(ABORT, 'offline_sale_authority_conflicts is append-only'); END;
      CREATE TRIGGER offline_sale_authority_conflicts_no_delete
        BEFORE DELETE ON offline_sale_authority_conflicts
        BEGIN SELECT RAISE(ABORT, 'offline_sale_authority_conflicts is append-only'); END;
    `)
  }
}
