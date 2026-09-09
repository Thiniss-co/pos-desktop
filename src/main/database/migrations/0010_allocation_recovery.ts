import type { DatabaseMigration } from '../migrator'

/**
 * BH-04B-4 durable cooperative-recovery state.
 *
 * This migration is additive. Migration 0009's constrained hold table is intentionally untouched:
 * recovery is an independent deny-spend reason backed directly by `stock_allocation_recoveries`,
 * so ordinary coverage reconciliation cannot clear or overwrite the no-more-sales boundary.
 */
export const allocationRecoveryMigration: DatabaseMigration = {
  version: 10,
  name: 'allocation_recovery',
  up(database): void {
    database.exec(`
      CREATE TABLE stock_allocation_recoveries (
        allocation_uuid TEXT NOT NULL,
        rights_generation INTEGER NOT NULL
          CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
        company_uuid TEXT NOT NULL,
        device_uuid TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'intent','sealed','acknowledged','terminal','conflict'
        )),
        request_seal_idempotency_key TEXT NOT NULL,
        expected_lifecycle_generation INTEGER NOT NULL
          CHECK (typeof(expected_lifecycle_generation)='integer' AND expected_lifecycle_generation >= 1),
        seal_generation INTEGER
          CHECK (seal_generation IS NULL OR
            (typeof(seal_generation)='integer' AND seal_generation >= 1)),
        seal_nonce TEXT,
        terminal_sequence INTEGER
          CHECK (terminal_sequence IS NULL OR
            (typeof(terminal_sequence)='integer' AND terminal_sequence >= 0)),
        terminal_consumed_quantity_milli INTEGER
          CHECK (terminal_consumed_quantity_milli IS NULL OR
            (typeof(terminal_consumed_quantity_milli)='integer' AND
             terminal_consumed_quantity_milli >= 0)),
        terminal_hash TEXT CHECK (terminal_hash IS NULL OR length(terminal_hash) = 64),
        acknowledge_idempotency_key TEXT,
        conflict_reason TEXT,
        intent_created_at TEXT NOT NULL,
        sealed_at TEXT,
        acknowledged_at TEXT,
        terminal_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (allocation_uuid, rights_generation),
        CHECK (
          state = 'intent' OR
          (seal_generation IS NOT NULL AND seal_nonce IS NOT NULL AND
           terminal_sequence IS NOT NULL AND terminal_consumed_quantity_milli IS NOT NULL AND
           terminal_hash IS NOT NULL AND acknowledge_idempotency_key IS NOT NULL AND
           sealed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE stock_allocation_recovery_dependencies (
        allocation_uuid TEXT NOT NULL,
        rights_generation INTEGER NOT NULL,
        local_consumption_uuid TEXT NOT NULL,
        invoice_local_uuid TEXT NOT NULL,
        invoice_idempotency_key TEXT NOT NULL,
        item_line_uuid TEXT NOT NULL,
        consumption_sequence INTEGER NOT NULL
          CHECK (typeof(consumption_sequence)='integer' AND consumption_sequence >= 1),
        quantity_milli INTEGER NOT NULL
          CHECK (typeof(quantity_milli)='integer' AND quantity_milli > 0),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        resolved_at TEXT,
        resolution_source TEXT CHECK (
          resolution_source IS NULL OR resolution_source IN ('invoice_upload','bootstrap','top_up')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (allocation_uuid, rights_generation, local_consumption_uuid),
        FOREIGN KEY (allocation_uuid, rights_generation)
          REFERENCES stock_allocation_recoveries(allocation_uuid, rights_generation)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX idx_stock_allocation_recovery_work
        ON stock_allocation_recoveries(company_uuid, device_uuid, state, updated_at);
      CREATE INDEX idx_stock_allocation_recovery_dependencies_invoice
        ON stock_allocation_recovery_dependencies(invoice_local_uuid, resolved_at);
    `)
  }
}
