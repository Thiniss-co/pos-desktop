import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 6 — fiscal identity, frozen fiscal context and the QR gate.
 *
 * - `fiscal_identity`: the mirror of the backend's negotiated `fiscal_identity` block, per company. It
 *   is replaced inside the bootstrap snapshot transaction and is only ever READ at commit time.
 * - `local_invoice_fiscal_context`: frozen INSIDE the sale-commit transaction — the regime, the seller
 *   identity and address as mirrored at that instant, and the exact QR payload the receipt carries.
 *   A ZATCA row must carry the full identity (CHECK). Immutable (triggers); reprints reuse it.
 * - `local_refund_fiscal_context`: frozen when the refund is ACCEPTED, from the server's frozen block
 *   (or a non-fiscal reference when the server sent none). Immutable.
 * - `receipt_profile_versions.display_options_json`: receipt profile v2 display choices.
 * - `receipt_print_jobs.qr_verified_sha256`: written by preparation once the rendered QR decoded to the
 *   expected payload; `beginDispatching` requires it for sale and refund documents.
 */
export const fiscalReceiptsMigration: DatabaseMigration = {
  version: 24,
  name: 'fiscal_receipts',
  up(database): void {
    database.exec(`
      CREATE TABLE fiscal_identity (
        company_uuid  TEXT PRIMARY KEY,
        regime        TEXT NOT NULL CHECK (regime IN ('none','sa_zatca_phase1')),
        seller_name   TEXT CHECK (seller_name IS NULL OR length(CAST(seller_name AS BLOB)) BETWEEN 1 AND 255),
        vat_number    TEXT CHECK (vat_number IS NULL OR length(vat_number) BETWEEN 1 AND 64),
        street        TEXT,
        city          TEXT,
        postal_code   TEXT,
        country       TEXT,
        revision      INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision >= 0),
        updated_at    TEXT NOT NULL
      ) STRICT;

      CREATE TABLE local_invoice_fiscal_context (
        invoice_local_uuid   TEXT PRIMARY KEY,
        company_uuid         TEXT NOT NULL,
        regime               TEXT NOT NULL CHECK (regime IN ('none','sa_zatca_phase1')),
        seller_name          TEXT,
        vat_number           TEXT,
        seller_address_json  TEXT,
        fiscal_revision      INTEGER CHECK (fiscal_revision IS NULL OR (typeof(fiscal_revision)='integer' AND fiscal_revision >= 0)),
        qr_type              TEXT NOT NULL CHECK (qr_type IN ('zatca-p1','txn-ref-v1')),
        qr_payload           TEXT NOT NULL CHECK (length(qr_payload) BETWEEN 1 AND 500),
        qr_sha256            TEXT NOT NULL CHECK (length(qr_sha256) = 64),
        created_at           TEXT NOT NULL,
        FOREIGN KEY (invoice_local_uuid, company_uuid) REFERENCES local_invoices(local_uuid, company_uuid),
        CHECK ((regime = 'sa_zatca_phase1') = (qr_type = 'zatca-p1')),
        CHECK (regime <> 'sa_zatca_phase1' OR (
          seller_name IS NOT NULL AND vat_number IS NOT NULL AND seller_address_json IS NOT NULL
          AND fiscal_revision IS NOT NULL
        ))
      ) STRICT;

      CREATE TRIGGER local_invoice_fiscal_context_immutable_update
      BEFORE UPDATE ON local_invoice_fiscal_context
      BEGIN
        SELECT RAISE(ABORT, 'local_invoice_fiscal_context is immutable');
      END;

      CREATE TRIGGER local_invoice_fiscal_context_immutable_delete
      BEFORE DELETE ON local_invoice_fiscal_context
      BEGIN
        SELECT RAISE(ABORT, 'local_invoice_fiscal_context is immutable');
      END;

      CREATE TABLE local_refund_fiscal_context (
        refund_local_uuid    TEXT PRIMARY KEY,
        company_uuid         TEXT NOT NULL,
        regime               TEXT NOT NULL CHECK (regime IN ('none','sa_zatca_phase1')),
        -- The server's frozen block verbatim (null when the server sent none).
        fiscal_json          TEXT,
        qr_type              TEXT NOT NULL CHECK (qr_type IN ('zatca-p1','txn-ref-v1')),
        qr_payload           TEXT NOT NULL CHECK (length(qr_payload) BETWEEN 1 AND 500),
        qr_sha256            TEXT NOT NULL CHECK (length(qr_sha256) = 64),
        created_at           TEXT NOT NULL,
        FOREIGN KEY (refund_local_uuid, company_uuid) REFERENCES local_refunds(local_uuid, company_uuid),
        CHECK ((regime = 'sa_zatca_phase1') = (qr_type = 'zatca-p1')),
        CHECK (regime <> 'sa_zatca_phase1' OR fiscal_json IS NOT NULL)
      ) STRICT;

      CREATE TRIGGER local_refund_fiscal_context_immutable_update
      BEFORE UPDATE ON local_refund_fiscal_context
      BEGIN
        SELECT RAISE(ABORT, 'local_refund_fiscal_context is immutable');
      END;

      CREATE TRIGGER local_refund_fiscal_context_immutable_delete
      BEFORE DELETE ON local_refund_fiscal_context
      BEGIN
        SELECT RAISE(ABORT, 'local_refund_fiscal_context is immutable');
      END;

      ALTER TABLE receipt_print_jobs ADD COLUMN qr_verified_sha256 TEXT
        CHECK (qr_verified_sha256 IS NULL OR length(qr_verified_sha256) = 64);

      -- Receipt profile v2: the version's display choices (NULL = a v1 version, everything shown).
      -- Kept beside the v1 fields so the v1 field hash and its revision-conflict rule are unchanged.
      ALTER TABLE receipt_profile_versions ADD COLUMN display_options_json TEXT;
    `)
  }
}
