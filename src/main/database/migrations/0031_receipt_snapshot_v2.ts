import type { DatabaseMigration } from '../migrator'

/**
 * Owner receipt copies — receipt snapshot v2 alongside v1. Additive in effect: every existing row is kept
 * byte for byte (its version, QR and canonical content never change).
 *
 * v1 carries the `txn-ref-v1` reference computed at the sale (sales without a frozen fiscal context).
 * v2 carries the frozen fiscal context (POS improvements 0024) and its exact QR, which is `txn-ref-v1`
 * or `zatca-p1` (up to 500 characters). A reference QR is never stored as a ZATCA one: v1 rows stay
 * `txn-ref-v1` (CHECK).
 *
 * SQLite cannot relax a CHECK in place, so the immutable table is rebuilt (copy, drop, rename, triggers
 * recreated) with foreign keys off around this migration's own transaction, the way 0022 rebuilds
 * `local_invoices`; `receipt_snapshot_uploads` keeps referencing it by name.
 */
export const receiptSnapshotV2Migration: DatabaseMigration = {
  version: 31,
  name: 'receipt_snapshot_v2',
  rebuildsForeignKeyReferencedTable: true,
  up(database) {
    database.exec(`
      CREATE TABLE local_invoice_receipt_snapshot_v31 (
        invoice_local_uuid  TEXT PRIMARY KEY REFERENCES local_invoice_receipt_context(invoice_local_uuid),
        company_uuid        TEXT NOT NULL CHECK (length(company_uuid) = 36),
        snapshot_version    INTEGER NOT NULL CHECK (snapshot_version IN (1, 2)),
        qr_type             TEXT NOT NULL CHECK (qr_type IN ('txn-ref-v1', 'zatca-p1')),
        qr_payload          TEXT NOT NULL CHECK (length(qr_payload) BETWEEN 1 AND 500),
        canonical_content   TEXT NOT NULL CHECK (length(CAST(canonical_content AS BLOB)) <= 16384),
        content_sha256      TEXT NOT NULL CHECK (length(content_sha256) = 64),
        created_at          TEXT NOT NULL,
        CHECK (snapshot_version = 2 OR qr_type = 'txn-ref-v1')
      ) STRICT;

      INSERT INTO local_invoice_receipt_snapshot_v31
        (invoice_local_uuid, company_uuid, snapshot_version, qr_type, qr_payload, canonical_content, content_sha256, created_at)
      SELECT invoice_local_uuid, company_uuid, snapshot_version, qr_type, qr_payload, canonical_content, content_sha256, created_at
      FROM local_invoice_receipt_snapshot;

      DROP TABLE local_invoice_receipt_snapshot;
      ALTER TABLE local_invoice_receipt_snapshot_v31 RENAME TO local_invoice_receipt_snapshot;

      CREATE TRIGGER trg_local_invoice_receipt_snapshot_no_update
      BEFORE UPDATE ON local_invoice_receipt_snapshot
      BEGIN SELECT RAISE(ABORT, 'receipt snapshot is immutable'); END;
      CREATE TRIGGER trg_local_invoice_receipt_snapshot_no_delete
      BEFORE DELETE ON local_invoice_receipt_snapshot
      BEGIN SELECT RAISE(ABORT, 'receipt snapshot is immutable'); END;
    `)
  }
}
