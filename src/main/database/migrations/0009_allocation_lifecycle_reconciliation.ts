import {
  allocationItemLineUuid,
  allocationJournalAppend,
  allocationJournalInitialHash
} from '../../services/allocationJournal'
import { invoiceRequestHashFromPayloadJson } from '../../services/invoiceRequestHash'
import type { DatabaseMigration } from '../migrator'
import type { SqliteDatabase } from '../connection'

/**
 * BH-04B-3 (BH-04A slice 3). Three things, all forward-only and all lossless.
 *
 * **1. The blocking defect.** Migration 0007 constrains the *legacy* `status` column with
 * `CHECK ((status = 'active') = (sealed_at IS NULL))` and a `released`-coupled
 * `final_consumption_*`/`finalized_at` rule, while the bootstrap upsert hardcodes `status='active'`
 * and writes the server's real `sealed_at`/`final_consumption_*`. Every backend envelope that is not
 * plainly active therefore aborts the whole catalog transaction. SQLite cannot drop a table CHECK,
 * so `stock_allocation_grants` is rebuilt. The legacy column is retained as a readable mirror, but
 * it is now *derived* from the authoritative `server_status` and constrained to agree with it, and
 * the two rules that encoded assumptions about backend lifecycle transitions are gone — a local
 * CHECK asserting how the server may move between states is what broke this in the first place.
 *
 * **2. Immutable journal evidence.** `local_stock_allocation_consumptions` gains the fields a
 * journal-v1 entry needs (BH-04A §3.1) so a coverage boundary can be *verified* rather than
 * trusted. Existing rows are backfilled from immutable evidence only — the referenced grant, the
 * invoice, the item line index, and the frozen `sync_queue.payload_json`. Nothing is invented: a row
 * whose payload is missing or unparseable keeps NULLs, and its grant is recorded as held so it
 * cannot be spent until authoritative reconciliation establishes its prefix.
 *
 * **3. Reconciliation state.** Accepted coverage boundaries, terminal markers, and durable holds get
 * their own tables. Neither the boundary nor the marker table has a foreign key to the grants table,
 * deliberately: an upload response can carry coverage for a grant absent from the current snapshot,
 * and a terminal marker must survive its allocation being absent locally — otherwise a later stale
 * envelope could reintroduce spendable rights.
 *
 * No shipped migration is edited and no database is deleted or recreated. The whole step runs inside
 * the migrator's own transaction, so any failure — including the `foreign_key_check` assertion at
 * the end — rolls back to the exact pre-0009 schema and rows.
 *
 * `rebuildsForeignKeyReferencedTable: true` below is load-bearing, not decorative — see the full
 * explanation and the confirmed-not-assumed detail on `defer_foreign_keys` in `migrator.ts`'s own
 * doc comment for that flag. In short: SQLite's own recommended procedure for this exact category
 * of change (sqlite.org/lang_altertable.html §8) is to disable `foreign_keys` outright before the
 * transaction starts, not to defer it — `defer_foreign_keys=ON` lets `DROP TABLE
 * stock_allocation_grants` succeed instead of failing immediately, but `COMMIT` still fails
 * afterward even once a fully-populated replacement has been renamed back into place, because the
 * deferred violation from the implicit `DELETE` (sqlite.org/foreignkeys.html §5) is never
 * reconciled by that rename. `PRAGMA foreign_keys` cannot be toggled once a transaction is open, so
 * the migrator disables/re-enables it strictly outside this migration's own transaction. The
 * `foreign_key_check` assertion at the end of `up()` is what keeps that safe: with enforcement off,
 * a real orphan would otherwise commit silently, so this method is the actual gate, and a violation
 * here still rolls back this migration's transaction.
 */
export const allocationLifecycleReconciliationMigration: DatabaseMigration = {
  version: 9,
  name: 'allocation_lifecycle_reconciliation',
  rebuildsForeignKeyReferencedTable: true,
  up(database) {
    rebuildStockAllocationGrants(database)
    addJournalEvidenceColumns(database)
    createReconciliationTables(database)
    backfillJournalEvidence(database)

    const violations = database.pragma('foreign_key_check') as unknown[]

    if (violations.length > 0) {
      throw new Error(
        `Migration 0009 left ${violations.length} foreign key violation(s); rolling back rather than committing a damaged schema`
      )
    }
  }
}

/** Statuses the legacy compatibility column may hold, unchanged from migration 0007. */
const LEGACY_STATUS_MAPPING = `CASE COALESCE(server_status, status)
             WHEN 'revocation_pending' THEN 'sealed'
             WHEN 'seal_acknowledged'  THEN 'sealed'
             WHEN 'active'             THEN 'active'
             WHEN 'consumed'           THEN 'consumed'
             WHEN 'released'           THEN 'released'
             ELSE status
           END`

function rebuildStockAllocationGrants(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE stock_allocation_grants_bh04b3 (
      allocation_uuid       TEXT PRIMARY KEY,
      contract_version      INTEGER NOT NULL
        CHECK (typeof(contract_version)='integer' AND contract_version >= 1),
      company_uuid          TEXT NOT NULL,
      device_uuid           TEXT NOT NULL,
      warehouse_uuid        TEXT NOT NULL,
      product_uuid          TEXT NOT NULL,
      server_sequence       INTEGER NOT NULL
        CHECK (typeof(server_sequence)='integer' AND server_sequence >= 1),
      rights_generation     INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
      lifecycle_generation  INTEGER NOT NULL
        CHECK (typeof(lifecycle_generation)='integer' AND lifecycle_generation >= 1),
      granted_quantity_milli INTEGER NOT NULL
        CHECK (typeof(granted_quantity_milli)='integer' AND granted_quantity_milli > 0),
      server_consumed_quantity_milli INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(server_consumed_quantity_milli)='integer' AND server_consumed_quantity_milli >= 0),
      server_remaining_quantity_milli INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(server_remaining_quantity_milli)='integer' AND server_remaining_quantity_milli >= 0),
      consume_until         TEXT NOT NULL,
      -- Legacy compatibility mirror, kept so pre-0008 evidence stays readable. It is derived from
      -- server_status and constrained to agree with it below; no authority code reads it while
      -- server_status is present.
      status                TEXT NOT NULL
        CHECK (status IN ('active','sealed','consumed','released','expired')),
      -- The authoritative Laravel lifecycle value. NULL only for rows written before migration 0008.
      server_status         TEXT
        CHECK (server_status IN ('active','revocation_pending','seal_acknowledged','released','consumed')),
      envelope_hash         TEXT NOT NULL CHECK (length(envelope_hash) = 64),
      seal_nonce            TEXT,
      final_consumption_sequence INTEGER
        CHECK (final_consumption_sequence IS NULL OR
               (typeof(final_consumption_sequence)='integer' AND final_consumption_sequence >= 0)),
      final_consumption_hash TEXT
        CHECK (final_consumption_hash IS NULL OR length(final_consumption_hash) = 64),
      received_at           TEXT NOT NULL,
      sealed_at             TEXT,
      acknowledged_at       TEXT,
      released_at           TEXT,
      finalized_at          TEXT,
      last_observed_revision INTEGER
        CHECK (last_observed_revision IS NULL OR
          (typeof(last_observed_revision)='integer' AND last_observed_revision >= 0)),
      updated_at            TEXT NOT NULL,
      -- The compatibility mirror may never disagree with the authoritative value. This is the only
      -- cross-column rule that remains, and it constrains *this app's own mapping*, never the
      -- backend's choice of lifecycle transition.
      CHECK (server_status IS NULL OR status = CASE server_status
        WHEN 'revocation_pending' THEN 'sealed'
        WHEN 'seal_acknowledged'  THEN 'sealed'
        ELSE server_status
      END),
      -- The two final-consumption columns are one piece of evidence and arrive together.
      CHECK ((final_consumption_sequence IS NULL) = (final_consumption_hash IS NULL)),
      -- finalized_at is never written by this app; if it ever is, it may only mean released.
      CHECK (finalized_at IS NULL OR status = 'released')
    ) STRICT;

    INSERT INTO stock_allocation_grants_bh04b3 (
      allocation_uuid, contract_version, company_uuid, device_uuid, warehouse_uuid, product_uuid,
      server_sequence, rights_generation, lifecycle_generation, granted_quantity_milli,
      server_consumed_quantity_milli, server_remaining_quantity_milli, consume_until, status,
      server_status, envelope_hash, seal_nonce, final_consumption_sequence, final_consumption_hash,
      received_at, sealed_at, acknowledged_at, released_at, finalized_at, last_observed_revision,
      updated_at
    )
    SELECT
      allocation_uuid, contract_version, company_uuid, device_uuid, warehouse_uuid, product_uuid,
      server_sequence, rights_generation, lifecycle_generation, granted_quantity_milli,
      server_consumed_quantity_milli, server_remaining_quantity_milli, consume_until,
      ${LEGACY_STATUS_MAPPING},
      server_status, envelope_hash, seal_nonce, final_consumption_sequence, final_consumption_hash,
      received_at, sealed_at, acknowledged_at, released_at, finalized_at, last_observed_revision,
      updated_at
    FROM stock_allocation_grants;

    DROP TABLE stock_allocation_grants;
  `)

  // `local_stock_allocation_consumptions` references the parent by name. With
  // `legacy_alter_table = ON` the rename does not rewrite that child clause, so the child ends up
  // pointing at the renamed table, which is exactly the intent of SQLite's documented rebuild
  // procedure. The pragma is restored immediately afterwards.
  database.pragma('legacy_alter_table = ON')
  database.exec('ALTER TABLE stock_allocation_grants_bh04b3 RENAME TO stock_allocation_grants;')
  database.pragma('legacy_alter_table = OFF')

  database.exec(`
    CREATE INDEX idx_stock_allocation_grants_available
      ON stock_allocation_grants(company_uuid, device_uuid, warehouse_uuid, product_uuid, status,
                                 consume_until, server_sequence, allocation_uuid);
    CREATE INDEX idx_stock_allocation_grants_bootstrap_authority
      ON stock_allocation_grants(
        company_uuid, device_uuid, warehouse_uuid, product_uuid, server_status,
        last_observed_revision, consume_until, server_sequence, allocation_uuid
      );
  `)
}

function addJournalEvidenceColumns(database: SqliteDatabase): void {
  database.exec(`
    -- Journal-v1 entry inputs. All nullable: a historical row whose evidence cannot be reconstructed
    -- keeps NULLs and holds its grant rather than being deleted or given invented values.
    ALTER TABLE local_stock_allocation_consumptions
      ADD COLUMN rights_generation INTEGER
      CHECK (rights_generation IS NULL OR
        (typeof(rights_generation)='integer' AND rights_generation >= 1));
    ALTER TABLE local_stock_allocation_consumptions ADD COLUMN invoice_idempotency_key TEXT;
    ALTER TABLE local_stock_allocation_consumptions ADD COLUMN item_line_uuid TEXT;
    ALTER TABLE local_stock_allocation_consumptions
      ADD COLUMN request_hash TEXT
      CHECK (request_hash IS NULL OR length(request_hash) = 64);
    ALTER TABLE local_stock_allocation_consumptions
      ADD COLUMN entry_hash TEXT
      CHECK (entry_hash IS NULL OR length(entry_hash) = 64);
    ALTER TABLE local_stock_allocation_consumptions
      ADD COLUMN chain_hash TEXT
      CHECK (chain_hash IS NULL OR length(chain_hash) = 64);

    CREATE INDEX idx_local_allocation_consumptions_journal
      ON local_stock_allocation_consumptions(allocation_uuid, rights_generation, consumption_sequence);
  `)
}

function createReconciliationTables(database: SqliteDatabase): void {
  database.exec(`
    -- The §3.1 coverage boundary this device has accepted, per immutable grant identity. Deliberately
    -- has NO foreign key to stock_allocation_grants: an invoice-upload response can carry coverage
    -- for an allocation that the current bootstrap snapshot no longer lists.
    CREATE TABLE stock_allocation_coverage_boundaries (
      allocation_uuid   TEXT NOT NULL,
      rights_generation INTEGER NOT NULL
        CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
      company_uuid      TEXT NOT NULL,
      device_uuid       TEXT NOT NULL,
      accepted_consumption_sequence INTEGER NOT NULL
        CHECK (typeof(accepted_consumption_sequence)='integer' AND accepted_consumption_sequence >= 0),
      accepted_consumed_quantity_milli INTEGER NOT NULL
        CHECK (typeof(accepted_consumed_quantity_milli)='integer' AND accepted_consumed_quantity_milli >= 0),
      accepted_chain_hash TEXT NOT NULL CHECK (length(accepted_chain_hash) = 64),
      source            TEXT NOT NULL CHECK (source IN ('bootstrap','top_up','invoice_upload')),
      observed_at       TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      PRIMARY KEY (allocation_uuid, rights_generation),
      CHECK ((accepted_consumption_sequence = 0) = (accepted_consumed_quantity_milli = 0))
    ) STRICT;

    -- Permanent terminal evidence. No foreign key, by design: a marker must be retained even when
    -- its allocation is absent locally, so a later stale active envelope cannot reintroduce rights.
    CREATE TABLE stock_allocation_terminal_markers (
      allocation_uuid   TEXT PRIMARY KEY,
      company_uuid      TEXT NOT NULL,
      device_uuid       TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('released','consumed')),
      lifecycle_generation INTEGER NOT NULL
        CHECK (typeof(lifecycle_generation)='integer' AND lifecycle_generation >= 1),
      terminal_revision INTEGER NOT NULL
        CHECK (typeof(terminal_revision)='integer' AND terminal_revision >= 0),
      observed_at       TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    ) STRICT;

    -- Durable deny-spend state. Written whenever observed evidence is missing, inconsistent or
    -- impossible; never cleared by a fallback path, only by authoritative reconciliation that
    -- actually establishes the boundary.
    CREATE TABLE stock_allocation_holds (
      allocation_uuid   TEXT NOT NULL,
      rights_generation INTEGER NOT NULL
        CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
      reason            TEXT NOT NULL CHECK (reason IN (
        'unreconstructable_prefix',
        'coverage_conflict',
        'coverage_inconsistent',
        'terminal_conflict'
      )),
      detail            TEXT,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (allocation_uuid, rights_generation)
    ) STRICT;

    -- Which response representation established the current snapshot. 'legacy' means the backend
    -- returned no coverage, so the pre-BH-04B-3 conservative guard stays in force; absent coverage
    -- is never treated as a verified zero boundary.
    ALTER TABLE bootstrap_allocation_capability
      ADD COLUMN representation TEXT NOT NULL DEFAULT 'legacy'
      CHECK (representation IN ('legacy','reconciliation_v2'));
  `)
}

interface ConsumptionBackfillRow {
  readonly local_uuid: string
  readonly allocation_uuid: string
  readonly consumption_sequence: number
  readonly quantity_milli: number
  readonly invoice_local_uuid: string
  readonly line_index: number | null
  readonly rights_generation: number | null
  readonly payload_json: string | null
}

/**
 * Reconstructs journal-v1 evidence for rows committed before this migration existed.
 *
 * Every input is immutable evidence that was already persisted: the grant's `rights_generation`, the
 * invoice uuid (which the payload builder always sends as `idempotency_key`), the item's
 * `line_index` (the same zero-based index the backend derives `item_line_uuid` from), and the frozen
 * queued request body. Today's mutable catalog rows are never consulted, and an upload *response* is
 * never substituted for its committed request.
 */
function backfillJournalEvidence(database: SqliteDatabase): void {
  const rows = database
    .prepare(
      `SELECT c.local_uuid, c.allocation_uuid, c.consumption_sequence, c.quantity_milli,
              c.invoice_local_uuid, i.line_index, g.rights_generation, q.payload_json
         FROM local_stock_allocation_consumptions c
         LEFT JOIN local_invoice_items i ON i.local_uuid = c.item_local_uuid
         LEFT JOIN stock_allocation_grants g ON g.allocation_uuid = c.allocation_uuid
         LEFT JOIN sync_queue q
                ON q.local_aggregate_uuid = c.invoice_local_uuid
               AND q.aggregate_type = 'invoice'
               AND q.operation = 'upload'
        ORDER BY c.allocation_uuid ASC, c.consumption_sequence ASC`
    )
    .all() as ConsumptionBackfillRow[]

  if (rows.length === 0) {
    return
  }

  const update = database.prepare(
    `UPDATE local_stock_allocation_consumptions
        SET rights_generation = ?, invoice_idempotency_key = ?, item_line_uuid = ?,
            request_hash = ?, entry_hash = ?, chain_hash = ?
      WHERE local_uuid = ?`
  )
  const hold = database.prepare(
    `INSERT INTO stock_allocation_holds (allocation_uuid, rights_generation, reason, detail, created_at)
     VALUES (?, ?, 'unreconstructable_prefix', ?, ?)
     ON CONFLICT(allocation_uuid, rights_generation) DO NOTHING`
  )

  const now = new Date().toISOString()
  const requestHashCache = new Map<string, string | null>()
  // Per allocation: the running chain hash, or null once the chain has become unreconstructable.
  const chains = new Map<string, string | null>()
  const held = new Map<string, { rightsGeneration: number; detail: string }>()

  for (const row of rows) {
    const rightsGeneration = row.rights_generation
    const chainKey = row.allocation_uuid

    if (rightsGeneration === null) {
      // The grant itself is gone, so there is no identity to key evidence by. The row is retained
      // untouched; there is no grant left to hold.
      continue
    }

    if (!chains.has(chainKey)) {
      chains.set(chainKey, allocationJournalInitialHash(chainKey, rightsGeneration))
    }

    const requestHash = resolveRequestHash(requestHashCache, row)
    const previousChainHash = chains.get(chainKey) ?? null
    const unreconstructable =
      requestHash === null || row.line_index === null || previousChainHash === null

    if (unreconstructable) {
      chains.set(chainKey, null)

      if (!held.has(chainKey)) {
        held.set(chainKey, {
          rightsGeneration,
          detail:
            requestHash === null
              ? 'the frozen upload payload for a committed consumption is missing or unhashable'
              : row.line_index === null
                ? 'the invoice item line for a committed consumption is missing'
                : 'an earlier consumption in this journal could not be reconstructed'
        })
      }

      continue
    }

    const itemLineUuid = allocationItemLineUuid(row.invoice_local_uuid, row.line_index as number)
    const entry = {
      allocationUuid: row.allocation_uuid,
      rightsGeneration,
      consumptionSequence: row.consumption_sequence,
      localConsumptionUuid: row.local_uuid,
      invoiceIdempotencyKey: row.invoice_local_uuid,
      itemLineUuid,
      quantityMilli: row.quantity_milli,
      requestHash
    }
    const hashes = allocationJournalAppend(previousChainHash, entry)

    update.run(
      rightsGeneration,
      row.invoice_local_uuid,
      itemLineUuid,
      requestHash,
      hashes.entryHash,
      hashes.chainHash,
      row.local_uuid
    )
    chains.set(chainKey, hashes.chainHash)
  }

  for (const [allocationUuid, entry] of held) {
    hold.run(allocationUuid, entry.rightsGeneration, entry.detail, now)
  }
}

function resolveRequestHash(
  cache: Map<string, string | null>,
  row: ConsumptionBackfillRow
): string | null {
  if (cache.has(row.invoice_local_uuid)) {
    return cache.get(row.invoice_local_uuid) ?? null
  }

  let hash: string | null = null

  if (row.payload_json !== null) {
    try {
      hash = invoiceRequestHashFromPayloadJson(row.payload_json)
    } catch {
      // A payload this app cannot hash the backend's way is unverifiable evidence, not a reason to
      // guess. The grant is held below.
      hash = null
    }
  }

  cache.set(row.invoice_local_uuid, hash)

  return hash
}

/** Exported for the migration suite: the exact legacy-status mapping this migration applies. */
export function legacyStatusForServerStatus(serverStatus: string | null, current: string): string {
  switch (serverStatus) {
    case 'revocation_pending':
    case 'seal_acknowledged':
      return 'sealed'
    case 'active':
    case 'consumed':
    case 'released':
      return serverStatus
    default:
      return current
  }
}
