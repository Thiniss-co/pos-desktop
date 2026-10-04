import type { DatabaseMigration } from '../migrator'

/**
 * Owner receipt copies — the sale's frozen receipt snapshot (v1) and its upload state. Additive only.
 *
 * Version 30 leaves 20–29 to the POS-improvements migrations; the migrator applies unapplied versions in
 * order, so the gap is safe in either merge order.
 *
 * - `bootstrap_capabilities` — what the server said it accepts, from the latest persisted bootstrap
 *   (cleared and re-inserted in that transaction). The DDL is shared verbatim with POS-improvements.
 * - `local_invoice_receipt_snapshot` — written in the sale-commit transaction next to the receipt context:
 *   the canonical JSON the register will upload (snapshot version, template version, the context row,
 *   the QR), its sha256 and the QR. Immutable: never updated or deleted.
 * - `receipt_snapshot_uploads` — one row per snapshot: pending until the server stores it (accepted) or
 *   refuses it for good (rejected, with the server's code). Only this row changes; the payload never does.
 */
export const receiptSnapshotsMigration: DatabaseMigration = {
  version: 30,
  name: 'receipt_snapshots',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS bootstrap_capabilities (
        capability  TEXT PRIMARY KEY CHECK (length(capability) BETWEEN 1 AND 64),
        version     INTEGER NOT NULL CHECK (version >= 1),
        updated_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE local_invoice_receipt_snapshot (
        invoice_local_uuid  TEXT PRIMARY KEY REFERENCES local_invoice_receipt_context(invoice_local_uuid),
        company_uuid        TEXT NOT NULL CHECK (length(company_uuid) = 36),
        snapshot_version    INTEGER NOT NULL CHECK (snapshot_version = 1),
        qr_type             TEXT NOT NULL CHECK (qr_type IN ('txn-ref-v1')),
        qr_payload          TEXT NOT NULL CHECK (length(qr_payload) BETWEEN 1 AND 255),
        canonical_content   TEXT NOT NULL CHECK (length(CAST(canonical_content AS BLOB)) <= 16384),
        content_sha256      TEXT NOT NULL CHECK (length(content_sha256) = 64),
        created_at          TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER trg_local_invoice_receipt_snapshot_no_update
      BEFORE UPDATE ON local_invoice_receipt_snapshot
      BEGIN SELECT RAISE(ABORT, 'receipt snapshot is immutable'); END;
      CREATE TRIGGER trg_local_invoice_receipt_snapshot_no_delete
      BEFORE DELETE ON local_invoice_receipt_snapshot
      BEGIN SELECT RAISE(ABORT, 'receipt snapshot is immutable'); END;

      CREATE TABLE receipt_snapshot_uploads (
        invoice_local_uuid  TEXT PRIMARY KEY REFERENCES local_invoice_receipt_snapshot(invoice_local_uuid),
        state               TEXT NOT NULL CHECK (state IN ('pending','accepted','rejected')),
        attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_attempt_at     TEXT,
        last_error_code     TEXT,
        settled_at          TEXT,
        updated_at          TEXT NOT NULL,
        CHECK ((state = 'pending') = (settled_at IS NULL)),
        CHECK (state <> 'rejected' OR last_error_code IS NOT NULL)
      ) STRICT;
      CREATE INDEX idx_receipt_snapshot_uploads_state ON receipt_snapshot_uploads(state);

      -- A settled upload is final: it never becomes pending again or flips between outcomes.
      CREATE TRIGGER trg_receipt_snapshot_uploads_settled_final
      BEFORE UPDATE ON receipt_snapshot_uploads
      WHEN OLD.state <> 'pending'
      BEGIN SELECT RAISE(ABORT, 'a settled receipt snapshot upload is final'); END;
    `)
  }
}
