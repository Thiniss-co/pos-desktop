import type { DatabaseMigration } from '../migrator'

/**
 * Allocation-dispatch evidence and allocation-envelope validation marks (POS reliability rev 3.1).
 *
 * Additive only. Three new tables and one new `sale_attempts` column:
 *
 * - `attempt_allocation_dispatches` — one row per top-up request identity this workstation sent
 *   (or is about to send). The row is written **before** the HTTP call, so a lost response, a crash
 *   or a restart can never leave a request identity the desktop no longer knows about. The request
 *   bytes and key are immutable; only the resolution columns change. It is request-identity
 *   evidence, never a stock ledger.
 * - `legacy_dispatch_uncertainties` — sale attempts that were still `claimed` when this migration
 *   ran were claimed by a build that recorded no dispatch evidence. Whether such an attempt ever
 *   sent a top-up cannot be established, so the uncertainty is kept explicitly, append-only, and is
 *   never marked reconciled.
 * - `stock_allocation_validation_marks` — the highest server-consumed quantity accepted for a grant
 *   at its current rights generation. Read by envelope validation only; spendability and coverage
 *   never read it.
 */
export const allocationDispatchEvidenceMigration: DatabaseMigration = {
  version: 16,
  name: 'allocation_dispatch_evidence',
  up(database) {
    database.exec(`
      CREATE TABLE attempt_allocation_dispatches (
        idempotency_key    TEXT PRIMARY KEY CHECK (length(idempotency_key) = 64),
        attempt_key        TEXT NOT NULL CHECK (length(attempt_key) BETWEEN 1 AND 64),
        company_uuid       TEXT NOT NULL,
        device_uuid        TEXT NOT NULL,
        warehouse_uuid     TEXT NOT NULL,
        actor_user_uuid    TEXT NOT NULL,
        request_hash       TEXT NOT NULL CHECK (length(request_hash) = 64),
        request_body_json  TEXT NOT NULL
          CHECK (length(CAST(request_body_json AS BLOB)) BETWEEN 2 AND 65536),
        state              TEXT NOT NULL
          CHECK (state IN ('dispatched','granted','refused','conflict','invalid')),
        send_count         INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(send_count) = 'integer' AND send_count >= 0),
        -- Sends whose server-side effect is unknown (transport loss, timeout, 5xx/429, malformed
        -- body, local persist failure). While this is zero, every send of this key received a
        -- definitive answer, so a pre-lookup 4xx proves the server holds no request for the key.
        ambiguous_send_count INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(ambiguous_send_count) = 'integer' AND ambiguous_send_count >= 0
                 AND ambiguous_send_count <= send_count),
        last_outcome_json  TEXT
          CHECK (last_outcome_json IS NULL OR length(CAST(last_outcome_json AS BLOB)) <= 4096),
        retry_not_before   TEXT,
        created_at         TEXT NOT NULL,
        resolved_at        TEXT,
        CHECK ((state = 'dispatched') = (resolved_at IS NULL))
      ) STRICT;

      CREATE INDEX idx_attempt_allocation_dispatches_attempt
        ON attempt_allocation_dispatches(attempt_key);
      CREATE INDEX idx_attempt_allocation_dispatches_owner_state
        ON attempt_allocation_dispatches(company_uuid, device_uuid, state);

      -- The identity and the exact bytes of a request never change once recorded.
      CREATE TRIGGER trg_attempt_allocation_dispatches_identity_frozen
      BEFORE UPDATE ON attempt_allocation_dispatches
      WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.attempt_key IS NOT OLD.attempt_key
        OR NEW.company_uuid IS NOT OLD.company_uuid
        OR NEW.device_uuid IS NOT OLD.device_uuid
        OR NEW.warehouse_uuid IS NOT OLD.warehouse_uuid
        OR NEW.actor_user_uuid IS NOT OLD.actor_user_uuid
        OR NEW.request_hash IS NOT OLD.request_hash
        OR NEW.request_body_json IS NOT OLD.request_body_json
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'allocation dispatch identity is immutable');
      END;

      -- granted, conflict and invalid are terminal; refused may only be re-sent (back to dispatched).
      CREATE TRIGGER trg_attempt_allocation_dispatches_transitions
      BEFORE UPDATE OF state ON attempt_allocation_dispatches
      WHEN NEW.state IS NOT OLD.state AND (
        OLD.state IN ('granted','conflict','invalid')
        OR (OLD.state = 'refused' AND NEW.state <> 'dispatched')
      )
      BEGIN
        SELECT RAISE(ABORT, 'allocation dispatch state transition is not allowed');
      END;

      CREATE TRIGGER trg_attempt_allocation_dispatches_no_delete
      BEFORE DELETE ON attempt_allocation_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'allocation dispatch evidence is never deleted');
      END;

      ALTER TABLE sale_attempts ADD COLUMN dispatch_evidence TEXT NOT NULL DEFAULT 'recorded'
        CHECK (dispatch_evidence IN ('recorded','unknown'));

      -- Attempts still claimed now were claimed by a build that recorded no dispatch evidence. The
      -- frozen intent carries no trackedness, so none of them can be proven dispatch-free.
      UPDATE sale_attempts SET dispatch_evidence = 'unknown' WHERE state = 'claimed';

      CREATE TABLE legacy_dispatch_uncertainties (
        attempt_key        TEXT PRIMARY KEY CHECK (length(attempt_key) BETWEEN 1 AND 64),
        company_uuid       TEXT NOT NULL,
        device_uuid        TEXT NOT NULL,
        user_uuid          TEXT NOT NULL,
        warehouse_uuid     TEXT NOT NULL,
        intent_json        TEXT NOT NULL
          CHECK (length(CAST(intent_json AS BLOB)) BETWEEN 2 AND 65536),
        product_quantities_json TEXT NOT NULL,
        claimed_at         TEXT NOT NULL,
        recorded_at        TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'open' CHECK (status = 'open')
      ) STRICT;

      CREATE INDEX idx_legacy_dispatch_uncertainties_owner
        ON legacy_dispatch_uncertainties(company_uuid, device_uuid, user_uuid);

      CREATE TRIGGER trg_legacy_dispatch_uncertainties_append_only
      BEFORE UPDATE ON legacy_dispatch_uncertainties
      BEGIN
        SELECT RAISE(ABORT, 'legacy dispatch uncertainty is append-only');
      END;

      CREATE TRIGGER trg_legacy_dispatch_uncertainties_no_delete
      BEFORE DELETE ON legacy_dispatch_uncertainties
      BEGIN
        SELECT RAISE(ABORT, 'legacy dispatch uncertainty is never deleted');
      END;

      -- Where the stored envelope of a grant was last taken from. A full bootstrap snapshot writes
      -- 'bootstrap'; a top-up or preparation response writes 'incremental'. At an equal allocation
      -- revision a bootstrap-sourced grant must reappear, while an incremental one may legitimately
      -- be newer than the snapshot's own allocation read. Existing rows keep the strict meaning.
      ALTER TABLE stock_allocation_grants ADD COLUMN observation_source TEXT NOT NULL
        DEFAULT 'bootstrap' CHECK (observation_source IN ('bootstrap','incremental'));

      CREATE TABLE stock_allocation_validation_marks (
        allocation_uuid              TEXT NOT NULL,
        rights_generation            INTEGER NOT NULL
          CHECK (typeof(rights_generation) = 'integer' AND rights_generation >= 1),
        consumed_high_water_milli    INTEGER NOT NULL
          CHECK (typeof(consumed_high_water_milli) = 'integer' AND consumed_high_water_milli >= 0),
        observed_revision            INTEGER NOT NULL
          CHECK (typeof(observed_revision) = 'integer' AND observed_revision >= 0),
        updated_at                   TEXT NOT NULL,
        PRIMARY KEY (allocation_uuid, rights_generation)
      ) STRICT;

      -- A validation mark only ever rises.
      CREATE TRIGGER trg_stock_allocation_validation_marks_monotonic
      BEFORE UPDATE ON stock_allocation_validation_marks
      WHEN NEW.consumed_high_water_milli < OLD.consumed_high_water_milli
      BEGIN
        SELECT RAISE(ABORT, 'an allocation validation mark never decreases');
      END;
    `)
  }
}
