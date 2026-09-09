import type { DatabaseMigration } from '../migrator'

/**
 * CP3 — durable local state for coordinated offline stock preparation (plan §5.6, §7.2).
 *
 * Additive throughout. The one change to an existing table is a new nullable `queue_sequence`
 * column on `sync_queue`; no shipped migration is edited, no existing row loses a value, and no
 * existing index or constraint changes meaning.
 *
 * ## The distinction this schema exists to enforce
 *
 * §7.2 is emphatic that the **evaluation cycle** and the **API operation** are two different
 * objects, and that confusing them is what made an earlier revision of the plan contradict itself.
 * They get two tables for exactly that reason:
 *
 *  - `prepare_cycles` is *local bookkeeping*. It is mutable until it freezes, it is where products
 *    are partitioned into eligible and blocked, and it never reaches the wire.
 *  - `prepare_operations` is the *immutable API identity* created from a cycle's eligible set. Once
 *    a row exists here, its `operation_uuid`, `canonical_request_json`, and `request_hash` may never
 *    change — enforced below by triggers, not merely by convention.
 *
 * Keeping the cycle out of the canonical bytes is what lets a superseded, never-dispatched cycle be
 * abandoned without changing the hash of an operation that may already have reached Laravel.
 *
 * ## The other distinction
 *
 * §5.4 names two truths that must never be conflated: *grant ingested* (per allocation, safe alone)
 * and *decision applied* (per operation, the only thing that closes it). `prepare_operations.state`
 * carries the second; the existing `stock_allocations` table carries the first. An ingested grant is
 * spendable under the ordinary rules whether or not its operation is closed, and no amount of grant
 * ingestion can move an operation to `applied`.
 */
export const offlineStockPreparationMigration: DatabaseMigration = {
  version: 11,
  name: 'offline_stock_preparation',
  up(database): void {
    database.exec(`
      -- ---------------------------------------------------------------------------------------
      -- Monotonic queue sequence (§7.2)
      -- ---------------------------------------------------------------------------------------
      -- Assigned in the same transaction that commits each queue row, so a cycle can capture a
      -- bounded high-water mark and prove which rows belong to it. Nullable and backfilled rather
      -- than NOT NULL: rewriting the shipped table would rebuild every existing queue row, and a
      -- backfilled ordering over (created_at, local_queue_uuid) reproduces the same claim order the
      -- repository already uses.
      ALTER TABLE sync_queue ADD COLUMN queue_sequence INTEGER;

      CREATE UNIQUE INDEX idx_sync_queue_sequence ON sync_queue(queue_sequence)
        WHERE queue_sequence IS NOT NULL;
    `)

    // Backfilled in insertion order so historical rows are ordered exactly as `claimDue()` already
    // orders them. A row created after this migration takes MAX(queue_sequence) + 1 in its own
    // commit transaction.
    const existing = database
      .prepare<[], { local_queue_uuid: string }>(
        `SELECT local_queue_uuid FROM sync_queue ORDER BY created_at ASC, local_queue_uuid ASC`
      )
      .all()
    const assign = database.prepare(
      `UPDATE sync_queue SET queue_sequence = ? WHERE local_queue_uuid = ?`
    )

    existing.forEach((row, index) => {
      assign.run(index + 1, row.local_queue_uuid)
    })

    database.exec(`
      -- ---------------------------------------------------------------------------------------
      -- The local evaluation cycle (§7.2 steps 1-3)
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE prepare_cycles (
        cycle_uuid TEXT PRIMARY KEY,
        company_uuid TEXT NOT NULL,
        device_uuid TEXT NOT NULL,
        warehouse_uuid TEXT NOT NULL,
        requested_policy_revision INTEGER NOT NULL
          CHECK (typeof(requested_policy_revision)='integer' AND requested_policy_revision >= 0),
        -- MAX(queue_sequence) at capture. Rows committed after this belong to the *next* cycle and
        -- can therefore never starve this one, however busy the till is.
        captured_queue_high_water INTEGER NOT NULL
          CHECK (typeof(captured_queue_high_water)='integer' AND captured_queue_high_water >= 0),
        state TEXT NOT NULL CHECK (state IN ('captured','frozen','blocked','superseded')),
        -- Set only when the cycle froze an operation. A blocked cycle dispatches nothing and has no
        -- operation at all, which is a normal terminal outcome, not a failure.
        operation_uuid TEXT,
        blocked_reason TEXT,
        captured_at TEXT NOT NULL,
        frozen_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'frozen') = (operation_uuid IS NOT NULL)),
        CHECK ((state = 'frozen') = (frozen_at IS NOT NULL)),
        CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;

      CREATE INDEX idx_prepare_cycles_owner
        ON prepare_cycles(company_uuid, device_uuid, warehouse_uuid, captured_at);

      -- One row per candidate product, carrying its partition. The blocked set is stored here as
      -- cycle state and is deliberately NOT part of any outbound request (§7.2 step 3): it is what
      -- the UI reports as held and what a later cycle re-evaluates, and it never occupies a slot in
      -- a frozen request.
      CREATE TABLE prepare_cycle_products (
        cycle_uuid TEXT NOT NULL REFERENCES prepare_cycles(cycle_uuid) ON DELETE CASCADE,
        product_uuid TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('eligible','blocked')),
        blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN (
          'pending_upload','uploading_ambiguous','retryable_error','terminal_conflict',
          'terminal_rejection','dependency_scope_unknown','owned_by_unresolved_operation',
          'policy_disabled','blocked_by_unreleased_hold'
        )),
        PRIMARY KEY (cycle_uuid, product_uuid),
        CHECK ((disposition = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;

      -- The explicit dependency join (§7.2). The high-water value proves bounded capture; this
      -- table is what makes an audit reproducible, because it names the exact rows considered.
      CREATE TABLE prepare_cycle_dependencies (
        cycle_uuid TEXT NOT NULL REFERENCES prepare_cycles(cycle_uuid) ON DELETE CASCADE,
        local_queue_uuid TEXT NOT NULL,
        queue_sequence INTEGER NOT NULL
          CHECK (typeof(queue_sequence)='integer' AND queue_sequence >= 1),
        queue_state TEXT NOT NULL,
        product_uuid TEXT,
        allocation_uuid TEXT,
        scope_known INTEGER NOT NULL DEFAULT 1 CHECK (scope_known IN (0,1)),
        PRIMARY KEY (cycle_uuid, local_queue_uuid, product_uuid, allocation_uuid)
      ) STRICT;

      -- ---------------------------------------------------------------------------------------
      -- The immutable API operation (§5.2, §5.3, §5.6)
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE prepare_operations (
        operation_uuid TEXT PRIMARY KEY,
        cycle_uuid TEXT NOT NULL REFERENCES prepare_cycles(cycle_uuid),
        company_uuid TEXT NOT NULL,
        device_uuid TEXT NOT NULL,
        warehouse_uuid TEXT NOT NULL,
        requested_policy_revision INTEGER NOT NULL
          CHECK (typeof(requested_policy_revision)='integer' AND requested_policy_revision >= 0),
        -- The exact bytes that will be sent, frozen before any dispatch. Recovery replays these
        -- verbatim; it never re-partitions, re-freezes, or re-hashes (§7.2).
        canonical_request_json TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        selected_product_uuids_json TEXT NOT NULL,
        -- Electron's own session epoch at freeze time. Not a client claim sent to broaden server
        -- authority (§5.2) — readiness is invalidated locally if it changes.
        captured_session_epoch INTEGER NOT NULL
          CHECK (typeof(captured_session_epoch)='integer' AND captured_session_epoch >= 1),

        state TEXT NOT NULL CHECK (state IN (
          'captured','dispatching','ambiguous','discovered_pending_replay',
          'applied','conflicted','superseded_before_dispatch','superseded_uncommitted'
        )),

        -- Proof of whether an HTTP request was ever initiated. §7.2 makes ambiguity the *default*
        -- classification: an implementation that cannot prove undispatch must choose the ambiguous
        -- branch, so this is written before the request leaves and read on restart.
        dispatch_started_at TEXT,

        -- The immutable decision, populated only when the completeness predicate passes.
        prepared_at TEXT,
        required_duration_seconds INTEGER
          CHECK (required_duration_seconds IS NULL OR
            (typeof(required_duration_seconds)='integer' AND required_duration_seconds > 0)),
        required_ready_until TEXT,
        authority_ready_until TEXT,
        result TEXT CHECK (result IS NULL OR result IN (
          'ready_72h','partial_time','partial_quantity','blocked','expired'
        )),
        primary_limiting_reason TEXT,
        applied_policy_revision INTEGER,
        manifest_json TEXT,
        authority_references_json TEXT,

        conflict_reason TEXT,
        captured_at TEXT NOT NULL,
        applied_at TEXT,
        updated_at TEXT NOT NULL,

        -- §5.4 item 6: the decision, its per-product outcomes, its grant links and its manifest
        -- commit together or not at all. A torn application would leave 'applied' without a
        -- manifest, so the state and the manifest are constrained to agree.
        CHECK ((state = 'applied') = (applied_at IS NOT NULL)),
        CHECK (state <> 'applied' OR (
          prepared_at IS NOT NULL AND required_ready_until IS NOT NULL AND
          authority_ready_until IS NOT NULL AND result IS NOT NULL AND
          manifest_json IS NOT NULL AND authority_references_json IS NOT NULL
        )),
        CHECK ((state = 'conflicted') = (conflict_reason IS NOT NULL))
      ) STRICT;

      CREATE INDEX idx_prepare_operations_owner
        ON prepare_operations(company_uuid, device_uuid, warehouse_uuid, state);

      -- One decision per selected product, including every zero (§5.4 item 3). A product with no
      -- row here is a *missing* decision and blocks completion; it is never read as a zero. §6.7 is
      -- the case this protects: an undiscovered grant and an explicit zero are indistinguishable
      -- from a discovery channel alone.
      CREATE TABLE prepare_operation_outcomes (
        operation_uuid TEXT NOT NULL REFERENCES prepare_operations(operation_uuid) ON DELETE CASCADE,
        product_uuid TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'full','partial_cap','partial_stock','zero_at_target','zero_cap','zero_stock',
          'blocked_by_unreleased_hold'
        )),
        granted_quantity_milli INTEGER NOT NULL
          CHECK (typeof(granted_quantity_milli)='integer' AND granted_quantity_milli >= 0),
        allocation_uuid TEXT,
        issued_at TEXT,
        consume_until TEXT,
        window_qualified_hold_milli INTEGER NOT NULL DEFAULT 0,
        short_lived_hold_milli INTEGER NOT NULL DEFAULT 0,
        expired_hold_milli INTEGER NOT NULL DEFAULT 0,
        quarantined_hold_milli INTEGER NOT NULL DEFAULT 0,
        blocking_allocation_uuids_json TEXT,
        PRIMARY KEY (operation_uuid, product_uuid),
        -- A granted outcome always names its allocation; a zero never does.
        CHECK ((granted_quantity_milli > 0) = (allocation_uuid IS NOT NULL))
      ) STRICT;

      -- Grants discovered as linked to an operation before its decision arrives (§5.6,
      -- "partial discovery"). The grant itself lives in 'stock_allocations' and is spendable; this
      -- only records that its origin has been observed, so the completeness predicate can check
      -- that every discovered grant appears in the decision.
      CREATE TABLE prepare_operation_discovered_grants (
        operation_uuid TEXT NOT NULL REFERENCES prepare_operations(operation_uuid) ON DELETE CASCADE,
        allocation_uuid TEXT NOT NULL,
        product_uuid TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (operation_uuid, allocation_uuid)
      ) STRICT;

      -- ---------------------------------------------------------------------------------------
      -- Immutability, enforced by the database rather than by convention
      -- ---------------------------------------------------------------------------------------
      -- §7.2 step 5: once dispatch begins — or once the outcome becomes ambiguous — neither the
      -- request body nor the operation identity may change, for any reason, including a product
      -- becoming blocked in the meantime. Editing a body that may already have reached Laravel is
      -- precisely what produces either a 409 or a second, unlinked grant.
      CREATE TRIGGER trg_prepare_operations_frozen_bytes
      BEFORE UPDATE OF canonical_request_json, request_hash, operation_uuid, selected_product_uuids_json
      ON prepare_operations
      FOR EACH ROW
      WHEN OLD.canonical_request_json <> NEW.canonical_request_json
        OR OLD.request_hash <> NEW.request_hash
        OR OLD.operation_uuid <> NEW.operation_uuid
        OR OLD.selected_product_uuids_json <> NEW.selected_product_uuids_json
      BEGIN
        SELECT RAISE(ABORT, 'A frozen preparation request may not be edited or re-hashed.');
      END;

      -- 'prepared_at' and 'authority_ready_until' are the anchors every countdown measures from
      -- (§8.5). Refresh, replay, restart, or a clock change must never rewrite them, and
      -- 'authority_ready_until' may only ever move *earlier* if it moves at all.
      CREATE TRIGGER trg_prepare_operations_immutable_anchors
      BEFORE UPDATE OF prepared_at, authority_ready_until, required_ready_until
      ON prepare_operations
      FOR EACH ROW
      WHEN (OLD.prepared_at IS NOT NULL AND OLD.prepared_at <> NEW.prepared_at)
        OR (OLD.required_ready_until IS NOT NULL AND OLD.required_ready_until <> NEW.required_ready_until)
        OR (OLD.authority_ready_until IS NOT NULL AND NEW.authority_ready_until > OLD.authority_ready_until)
      BEGIN
        SELECT RAISE(ABORT, 'A preparation window anchor may not be rewritten or extended.');
      END;

      -- Terminal states are terminal. 'applied', 'conflicted', 'superseded_before_dispatch', and
      -- 'superseded_uncommitted' never transition again (§5.6).
      CREATE TRIGGER trg_prepare_operations_terminal_state
      BEFORE UPDATE OF state ON prepare_operations
      FOR EACH ROW
      WHEN OLD.state IN ('applied','conflicted','superseded_before_dispatch','superseded_uncommitted')
        AND NEW.state <> OLD.state
      BEGIN
        SELECT RAISE(ABORT, 'A terminal preparation operation state may not change.');
      END;
    `)
  }
}
