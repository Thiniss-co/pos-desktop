import type { DatabaseMigration } from '../migrator'

/**
 * PS6b — durable local state for operator-disposition discovery and convergence (plan §7.3a.5).
 *
 * Purely additive: four new tables, and **no change of any kind** to
 * `local_stock_allocation_consumptions`. That omission is the most important thing about this
 * migration.
 *
 * ## Why the consumption journal is not touched
 *
 * An earlier design widened `server_status` to mark an overridden consumption so it would drop out
 * of the spendable calculation. Source shows why that is unsafe:
 *
 *  - reconciliation subtracts EVERY committed row above the accepted boundary, regardless of
 *    acknowledgement status;
 *  - `nextConsumptionSequence()` takes the maximum of every local row;
 *  - the next chain hash extends the newest row;
 *  - and the server independently requires a gap-free sequence and recomputes that same chain.
 *
 * So excluding sequence 5 from a quantity sum cannot make server sequence 6 valid, and cannot
 * reproduce local hash H6 either. The quantity would look reusable while the chain stayed broken —
 * the worst of both. PS6b therefore leaves the journal completely alone and adds an INDEPENDENT
 * deny-spend hold instead.
 *
 * ## Why a separate hold table
 *
 * `stock_allocation_holds` is not usable for this: ordinary reconciliation can DELETE from it, so a
 * later boundary that verifies would silently clear a hold that must never clear. A disposition hold
 * has no clearing path in this scope at all — closing it would require a separately proven
 * consumption or release, under the release gate that remains disabled.
 */
export const dispositionDiscoveryMigration: DatabaseMigration = {
  version: 13,
  name: 'disposition_discovery',
  up(database): void {
    database.exec(`
      -- ---------------------------------------------------------------------------------------
      -- One applied disposition per local invoice (§7.3a.5)
      -- ---------------------------------------------------------------------------------------
      -- Keyed uniquely by BOTH the local invoice and the server disposition UUID. Two constraints,
      -- two different duplicates:
      --   * invoice_local_uuid UNIQUE  -- one decision may ever be applied to one sale;
      --   * disposition_uuid   UNIQUE  -- the same decision cannot be applied twice.
      -- An exact rediscovery is therefore a no-op, and a SECOND decision for the same invoice is a
      -- conflict rather than an overwrite.
      CREATE TABLE invoice_disposition_applications (
        invoice_local_uuid   TEXT PRIMARY KEY REFERENCES local_invoices(local_uuid),
        disposition_uuid     TEXT NOT NULL UNIQUE,
        decision             TEXT NOT NULL CHECK (decision IN ('accept_without_proof','reject_permanently')),
        result_version       INTEGER NOT NULL CHECK (typeof(result_version)='integer' AND result_version >= 1),
        -- The canonical result bytes and their hash, stored as received and verified. Retained so a
        -- later reader can prove WHAT was applied, not merely that something was.
        result_json          TEXT NOT NULL,
        result_hash          TEXT NOT NULL CHECK (length(result_hash) = 64),
        -- A copy and hash of the original queue failure evidence, so the row this decision acted on
        -- is provable after the queue row itself has moved on.
        queue_failure_json   TEXT NOT NULL,
        queue_failure_hash   TEXT NOT NULL CHECK (length(queue_failure_hash) = 64),
        request_hash         TEXT NOT NULL CHECK (length(request_hash) = 64),
        remote_invoice_uuid  TEXT,
        applied_at           TEXT NOT NULL,
        CHECK (decision <> 'reject_permanently' OR remote_invoice_uuid IS NULL)
      ) STRICT;

      -- ---------------------------------------------------------------------------------------
      -- The proof-by-proof outcome, one row per frozen proof (§7.3a.3)
      -- ---------------------------------------------------------------------------------------
      -- Stored locally so the desktop's own record enumerates every proof exactly once, matching
      -- the server result it verified. An accepted proof carries a server consumption UUID; an
      -- overridden one never does, and the CHECK makes the two states structurally exclusive rather
      -- than merely conventional.
      CREATE TABLE invoice_disposition_proof_results (
        invoice_local_uuid       TEXT NOT NULL REFERENCES invoice_disposition_applications(invoice_local_uuid),
        line_index               INTEGER NOT NULL CHECK (typeof(line_index)='integer' AND line_index >= 0),
        proof_index              INTEGER NOT NULL CHECK (typeof(proof_index)='integer' AND proof_index >= 0),
        allocation_uuid          TEXT NOT NULL,
        rights_generation        INTEGER NOT NULL CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
        consumption_sequence     INTEGER NOT NULL CHECK (typeof(consumption_sequence)='integer' AND consumption_sequence >= 1),
        local_consumption_uuid   TEXT NOT NULL,
        quantity_milli           INTEGER NOT NULL CHECK (typeof(quantity_milli)='integer' AND quantity_milli >= 1),
        outcome                  TEXT NOT NULL CHECK (outcome IN ('accepted','overridden')),
        server_consumption_uuid  TEXT,
        override_reason          TEXT,
        created_at               TEXT NOT NULL,
        PRIMARY KEY (invoice_local_uuid, line_index, proof_index),
        CHECK ((outcome = 'accepted') = (server_consumption_uuid IS NOT NULL)),
        CHECK ((outcome = 'overridden') = (override_reason IS NOT NULL))
      ) STRICT;

      -- ---------------------------------------------------------------------------------------
      -- The durable deny-spend hold (§7.3a.5, review finding T7)
      -- ---------------------------------------------------------------------------------------
      -- Deliberately NOT stock_allocation_holds: ordinary reconciliation deletes from that table, and
      -- this hold must survive a later verifying boundary. There is no clearing path here in this
      -- scope, which is why the column is a constant rather than a flag someone could flip.
      CREATE TABLE stock_allocation_disposition_holds (
        allocation_uuid          TEXT NOT NULL,
        rights_generation        INTEGER NOT NULL CHECK (typeof(rights_generation)='integer' AND rights_generation >= 1),
        invoice_local_uuid       TEXT NOT NULL REFERENCES invoice_disposition_applications(invoice_local_uuid),
        first_overridden_sequence INTEGER NOT NULL CHECK (typeof(first_overridden_sequence)='integer' AND first_overridden_sequence >= 1),
        reason                   TEXT NOT NULL CHECK (reason = 'invoice_disposition_chain_break'),
        -- Structurally false. A release requires a separately proven consumption or release under a
        -- gate that stays disabled, so this is not a decision this table can express.
        release_allowed          INTEGER NOT NULL DEFAULT 0 CHECK (release_allowed = 0),
        created_at               TEXT NOT NULL,
        PRIMARY KEY (allocation_uuid, rights_generation)
      ) STRICT;
      CREATE INDEX idx_disposition_holds_invoice
        ON stock_allocation_disposition_holds(invoice_local_uuid);

      -- ---------------------------------------------------------------------------------------
      -- Discovery contract conflicts (§7.3a.5)
      -- ---------------------------------------------------------------------------------------
      -- A malformed body, a hash mismatch, a proof-set disagreement, a second decision for the same
      -- invoice, or an invoice UUID collision. Recorded rather than retried, because none of those
      -- is a transport problem: repeating the request would produce the same disagreement. The row
      -- is durable evidence for the operator review screen.
      CREATE TABLE invoice_disposition_conflicts (
        local_uuid           TEXT PRIMARY KEY,
        invoice_local_uuid   TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        disposition_uuid     TEXT,
        conflict_code        TEXT NOT NULL,
        detail_json          TEXT NOT NULL,
        observed_at          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_disposition_conflicts_invoice
        ON invoice_disposition_conflicts(invoice_local_uuid, observed_at);
    `)
  }
}
