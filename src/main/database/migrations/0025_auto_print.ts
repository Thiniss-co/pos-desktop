import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 7 — automatic printing as an immutable intent plus an insert-once admission.
 *
 * - `auto_print_intents`: written INSIDE the sale-commit transaction when the selling user's
 *   `printing.autoPrint` preference is on (absent = on, D3). It freezes the owner, the locale and a
 *   snapshot of the workstation printer settings at that instant. It is never updated or deleted, and
 *   it carries no session epoch and no job reference.
 * - `auto_print_admissions`: exactly one decision per intent, never changed. `admitted` links the one
 *   AUTO print job, created in the SAME transaction as this row; every other outcome is terminal and
 *   leaves manual printing as the only path. An intent with no admission row is pending.
 */
export const autoPrintMigration: DatabaseMigration = {
  version: 25,
  name: 'auto_print',
  up(database): void {
    database.exec(`
      CREATE TABLE auto_print_intents (
        invoice_local_uuid       TEXT PRIMARY KEY,
        company_uuid             TEXT NOT NULL,
        device_uuid              TEXT NOT NULL,
        user_uuid                TEXT NOT NULL,
        committed_at             TEXT NOT NULL,
        locale                   TEXT NOT NULL CHECK (locale IN ('en','ar')),
        printer_snapshot_json    TEXT NOT NULL CHECK (json_valid(printer_snapshot_json)),
        printer_snapshot_sha256  TEXT NOT NULL CHECK (length(printer_snapshot_sha256) = 64),
        setup_state_at_commit    TEXT NOT NULL CHECK (setup_state_at_commit IN ('configured','no_printer')),
        FOREIGN KEY (invoice_local_uuid, company_uuid) REFERENCES local_invoices(local_uuid, company_uuid),
        CHECK ((setup_state_at_commit = 'no_printer')
               = (json_extract(printer_snapshot_json, '$.printerName') IS NULL))
      ) STRICT;

      CREATE INDEX idx_auto_print_intents_owner
        ON auto_print_intents(company_uuid, device_uuid, user_uuid, committed_at);

      CREATE TRIGGER auto_print_intents_immutable_update
      BEFORE UPDATE ON auto_print_intents
      BEGIN
        SELECT RAISE(ABORT, 'auto_print_intents is immutable');
      END;

      CREATE TRIGGER auto_print_intents_immutable_delete
      BEFORE DELETE ON auto_print_intents
      BEGIN
        SELECT RAISE(ABORT, 'auto_print_intents is immutable');
      END;

      CREATE TABLE auto_print_admissions (
        invoice_local_uuid      TEXT PRIMARY KEY REFERENCES auto_print_intents(invoice_local_uuid),
        job_uuid                TEXT UNIQUE REFERENCES receipt_print_jobs(job_uuid),
        outcome                 TEXT NOT NULL CHECK (outcome IN (
                                  'admitted','skipped_no_printer','printer_missing',
                                  'settings_changed','expired_unprinted')),
        admitted_session_epoch  INTEGER CHECK (admitted_session_epoch IS NULL
                                  OR (typeof(admitted_session_epoch) = 'integer' AND admitted_session_epoch >= 1)),
        decided_at              TEXT NOT NULL,
        CHECK ((outcome = 'admitted') = (job_uuid IS NOT NULL)),
        CHECK ((outcome = 'admitted') = (admitted_session_epoch IS NOT NULL))
      ) STRICT;

      -- An admitted row may only link the AUTO job of the same sale.
      CREATE TRIGGER auto_print_admissions_job_matches
      BEFORE INSERT ON auto_print_admissions
      WHEN NEW.job_uuid IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM receipt_print_jobs
         WHERE job_uuid = NEW.job_uuid AND trigger = 'auto'
           AND document_kind = 'sale' AND document_local_uuid = NEW.invoice_local_uuid
      )
      BEGIN
        SELECT RAISE(ABORT, 'an admission must link the AUTO job of its own sale');
      END;

      CREATE TRIGGER auto_print_admissions_immutable_update
      BEFORE UPDATE ON auto_print_admissions
      BEGIN
        SELECT RAISE(ABORT, 'auto_print_admissions is immutable');
      END;

      CREATE TRIGGER auto_print_admissions_immutable_delete
      BEFORE DELETE ON auto_print_admissions
      BEGIN
        SELECT RAISE(ABORT, 'auto_print_admissions is immutable');
      END;
    `)
  }
}
