import type { DatabaseMigration } from '../migrator'

/**
 * Makes the bootstrap allocation envelope durable without rewriting migration 0007. The original
 * table's `status` check is retained for backward-readable evidence; `server_status` is the exact
 * authoritative Laravel lifecycle value and is the only status new authority code consults.
 */
export const bootstrapStockAllocationsMigration: DatabaseMigration = {
  version: 8,
  name: 'bootstrap_stock_allocations',
  up(database) {
    database.exec(`
      ALTER TABLE stock_allocation_grants
        ADD COLUMN rights_generation INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(rights_generation) = 'integer' AND rights_generation >= 1);
      ALTER TABLE stock_allocation_grants
        ADD COLUMN server_consumed_quantity_milli INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(server_consumed_quantity_milli) = 'integer' AND server_consumed_quantity_milli >= 0);
      ALTER TABLE stock_allocation_grants
        ADD COLUMN server_remaining_quantity_milli INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(server_remaining_quantity_milli) = 'integer' AND server_remaining_quantity_milli >= 0);
      ALTER TABLE stock_allocation_grants
        ADD COLUMN server_status TEXT
        CHECK (server_status IN ('active','revocation_pending','seal_acknowledged','released','consumed'));
      ALTER TABLE stock_allocation_grants ADD COLUMN seal_nonce TEXT;
      ALTER TABLE stock_allocation_grants ADD COLUMN acknowledged_at TEXT;
      ALTER TABLE stock_allocation_grants ADD COLUMN released_at TEXT;
      ALTER TABLE stock_allocation_grants
        ADD COLUMN last_observed_revision INTEGER
        CHECK (last_observed_revision IS NULL OR
          (typeof(last_observed_revision) = 'integer' AND last_observed_revision >= 0));

      CREATE TABLE bootstrap_allocation_capability (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (state IN ('supported','unavailable')),
        revision INTEGER
          CHECK (revision IS NULL OR (typeof(revision) = 'integer' AND revision >= 0)),
        observed_at TEXT NOT NULL,
        CHECK ((state = 'supported') = (revision IS NOT NULL))
      ) STRICT;

      CREATE INDEX idx_stock_allocation_grants_bootstrap_authority
        ON stock_allocation_grants(
          company_uuid, device_uuid, warehouse_uuid, product_uuid, server_status,
          last_observed_revision, consume_until, server_sequence, allocation_uuid
        );
    `)
  }
}
