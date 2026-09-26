import type { DatabaseMigration } from '../migrator'

/**
 * Receipt-printing plan (rev 5) — additive schema for receipt context capture, the print-job
 * journal, and the company-receipt-profile mirror.
 *
 * The ONLY change to an existing table is three new UNIQUE indexes (plan §D-8): each contains the
 * parent's existing PRIMARY KEY column, so none can fail on existing data, and none rebuilds or
 * alters an existing column. Everything else is a brand-new table.
 */
export const receiptPrintingMigration: DatabaseMigration = {
  version: 15,
  name: 'receipt_printing',
  up(database) {
    database.exec(`
      -- Plan §D-8: tenant-scoped parent keys for the composite FKs below. Additive only.
      CREATE UNIQUE INDEX idx_local_invoices_owner ON local_invoices(local_uuid, company_uuid);
      CREATE UNIQUE INDEX idx_local_refunds_owner ON local_refunds(local_uuid, company_uuid);
      CREATE UNIQUE INDEX idx_local_refund_items_identity
        ON local_refund_items(local_uuid, refund_local_uuid, invoice_item_remote_uuid);

      -- ---------------------------------------------------------------------------------------
      -- Plan §D-11: company receipt-profile mirror. Insert-only versions/assets; the "current"
      -- pointer is the only mutable row, one per company.
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE receipt_profile_assets (
        company_uuid   TEXT NOT NULL,
        sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
        media_type     TEXT NOT NULL CHECK (media_type = 'image/png'),
        width_px       INTEGER NOT NULL CHECK (typeof(width_px)='integer' AND width_px BETWEEN 1 AND 384),
        height_px      INTEGER NOT NULL CHECK (typeof(height_px)='integer' AND height_px BETWEEN 1 AND 192),
        byte_length    INTEGER NOT NULL CHECK (typeof(byte_length)='integer' AND byte_length BETWEEN 1 AND 262144),
        content        BLOB,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','available')),
        created_at     TEXT NOT NULL,
        fetched_at     TEXT,
        PRIMARY KEY (company_uuid, sha256),
        CHECK ((status = 'available') = (content IS NOT NULL))
      ) STRICT;

      CREATE TRIGGER trg_receipt_profile_assets_only_pending_to_available
      BEFORE UPDATE ON receipt_profile_assets
      WHEN NOT (OLD.status = 'pending' AND NEW.status = 'available'
                AND NEW.company_uuid = OLD.company_uuid AND NEW.sha256 = OLD.sha256
                AND NEW.media_type = OLD.media_type AND NEW.width_px = OLD.width_px
                AND NEW.height_px = OLD.height_px AND NEW.byte_length = OLD.byte_length
                AND NEW.created_at = OLD.created_at)
      BEGIN SELECT RAISE(ABORT, 'receipt_profile_assets: only a pending row may become available, once'); END;

      CREATE TRIGGER trg_receipt_profile_assets_no_delete
      BEFORE DELETE ON receipt_profile_assets
      BEGIN SELECT RAISE(ABORT, 'receipt_profile_assets rows are retained'); END;

      CREATE TABLE receipt_profile_versions (
        version_uuid       TEXT PRIMARY KEY,
        company_uuid       TEXT NOT NULL,
        revision           INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision >= 1),
        fields_json        TEXT NOT NULL,
        fields_sha256      TEXT NOT NULL CHECK (length(fields_sha256) = 64),
        logo_sha256        TEXT,
        received_at        TEXT NOT NULL,
        UNIQUE (company_uuid, revision),
        UNIQUE (version_uuid, company_uuid),
        FOREIGN KEY (company_uuid, logo_sha256)
          REFERENCES receipt_profile_assets(company_uuid, sha256)
      ) STRICT;
      CREATE INDEX idx_receipt_profile_versions_company ON receipt_profile_versions(company_uuid, revision);

      CREATE TRIGGER trg_receipt_profile_versions_no_update
      BEFORE UPDATE ON receipt_profile_versions
      BEGIN SELECT RAISE(ABORT, 'receipt_profile_versions rows are insert-only'); END;
      CREATE TRIGGER trg_receipt_profile_versions_no_delete
      BEFORE DELETE ON receipt_profile_versions
      BEGIN SELECT RAISE(ABORT, 'receipt_profile_versions rows are insert-only'); END;

      CREATE TABLE receipt_profile_current (
        company_uuid  TEXT PRIMARY KEY,
        version_uuid  TEXT,
        capability    TEXT NOT NULL CHECK (capability IN ('unsupported','supported')),
        updated_at    TEXT NOT NULL,
        FOREIGN KEY (version_uuid, company_uuid)
          REFERENCES receipt_profile_versions(version_uuid, company_uuid)
      ) STRICT;

      -- Server-issued, per-(company,user) receipt-profile administration capability (plan §D-10
      -- "Correction A"). Refreshed on every bootstrap ingest; a missing/stale row is read as
      -- false (fail-closed). Never the security boundary by itself -- every write still goes
      -- through the backend, which re-checks role+permission authoritatively.
      CREATE TABLE receipt_profile_authority (
        company_uuid  TEXT NOT NULL,
        user_uuid     TEXT NOT NULL,
        can_manage    INTEGER NOT NULL CHECK (can_manage IN (0,1)),
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (company_uuid, user_uuid)
      ) STRICT;

      -- ---------------------------------------------------------------------------------------
      -- Plan §D-2/§D-8: immutable receipt context, captured inside the existing sale-commit and
      -- refund-insert transactions. Never read by the upload mapping or the request hash.
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE local_invoice_receipt_context (
        invoice_local_uuid       TEXT PRIMARY KEY,
        company_uuid             TEXT NOT NULL,
        context_version          INTEGER NOT NULL CHECK (typeof(context_version)='integer' AND context_version >= 1),
        issuer_company_name      TEXT NOT NULL CHECK (length(issuer_company_name) BETWEEN 1 AND 255),
        issuer_branch_name       TEXT CHECK (issuer_branch_name IS NULL OR length(issuer_branch_name) <= 255),
        issuer_warehouse_name    TEXT CHECK (issuer_warehouse_name IS NULL OR length(issuer_warehouse_name) <= 255),
        cashier_display_name     TEXT CHECK (cashier_display_name IS NULL OR length(cashier_display_name) <= 255),
        customer_name            TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 255),
        customer_tax_number      TEXT CHECK (customer_tax_number IS NULL OR length(customer_tax_number) <= 64),
        time_zone                TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
        receipt_profile_version_uuid TEXT,
        created_at               TEXT NOT NULL,
        FOREIGN KEY (invoice_local_uuid, company_uuid)
          REFERENCES local_invoices(local_uuid, company_uuid),
        FOREIGN KEY (receipt_profile_version_uuid, company_uuid)
          REFERENCES receipt_profile_versions(version_uuid, company_uuid)
      ) STRICT;

      CREATE TRIGGER trg_local_invoice_receipt_context_no_update
      BEFORE UPDATE ON local_invoice_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;
      CREATE TRIGGER trg_local_invoice_receipt_context_no_delete
      BEFORE DELETE ON local_invoice_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;

      CREATE TABLE local_refund_receipt_context (
        refund_local_uuid        TEXT PRIMARY KEY,
        company_uuid             TEXT NOT NULL,
        context_version          INTEGER NOT NULL CHECK (typeof(context_version)='integer' AND context_version >= 1),
        issuer_company_name      TEXT NOT NULL CHECK (length(issuer_company_name) BETWEEN 1 AND 255),
        issuer_branch_name       TEXT CHECK (issuer_branch_name IS NULL OR length(issuer_branch_name) <= 255),
        cashier_display_name     TEXT CHECK (cashier_display_name IS NULL OR length(cashier_display_name) <= 255),
        payment_method_name      TEXT CHECK (payment_method_name IS NULL OR length(payment_method_name) <= 255),
        original_offline_number  TEXT NOT NULL,
        original_server_number   TEXT,
        time_zone                TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
        receipt_profile_version_uuid TEXT,
        created_at               TEXT NOT NULL,
        FOREIGN KEY (refund_local_uuid, company_uuid)
          REFERENCES local_refunds(local_uuid, company_uuid),
        FOREIGN KEY (receipt_profile_version_uuid, company_uuid)
          REFERENCES receipt_profile_versions(version_uuid, company_uuid)
      ) STRICT;

      CREATE TRIGGER trg_local_refund_receipt_context_no_update
      BEFORE UPDATE ON local_refund_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;
      CREATE TRIGGER trg_local_refund_receipt_context_no_delete
      BEFORE DELETE ON local_refund_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;

      -- Plan §D-1/§D-8: per-line refund descriptors, retained from the exact original SERVER
      -- invoice item at preview time. The composite FK is the enforceable identity invariant --
      -- it can reference ONLY an item that belongs to THIS refund AND whose
      -- invoice_item_remote_uuid matches exactly, so a line can never be cross-associated with
      -- another refund's item or a different original server line, even for the same product.
      CREATE TABLE local_refund_line_receipt_context (
        refund_item_local_uuid      TEXT PRIMARY KEY,
        refund_local_uuid           TEXT NOT NULL,
        invoice_item_remote_uuid    TEXT NOT NULL,
        original_unit_price_amount  INTEGER CHECK (original_unit_price_amount IS NULL
          OR (typeof(original_unit_price_amount)='integer' AND original_unit_price_amount BETWEEN 0 AND 900000000000000)),
        original_quantity_milli     INTEGER CHECK (original_quantity_milli IS NULL
          OR (typeof(original_quantity_milli)='integer' AND original_quantity_milli BETWEEN 1 AND 999999999)),
        unit                        TEXT CHECK (unit IS NULL OR length(unit) <= 64),
        sku                         TEXT CHECK (sku IS NULL OR length(sku) <= 255),
        tax_rate_text               TEXT CHECK (tax_rate_text IS NULL OR length(tax_rate_text) <= 16),
        created_at                  TEXT NOT NULL,
        FOREIGN KEY (refund_item_local_uuid, refund_local_uuid, invoice_item_remote_uuid)
          REFERENCES local_refund_items(local_uuid, refund_local_uuid, invoice_item_remote_uuid),
        FOREIGN KEY (refund_local_uuid)
          REFERENCES local_refund_receipt_context(refund_local_uuid)
      ) STRICT;
      CREATE INDEX idx_local_refund_line_receipt_context_refund
        ON local_refund_line_receipt_context(refund_local_uuid);

      CREATE TRIGGER trg_local_refund_line_receipt_context_no_update
      BEFORE UPDATE ON local_refund_line_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;
      CREATE TRIGGER trg_local_refund_line_receipt_context_no_delete
      BEFORE DELETE ON local_refund_line_receipt_context
      BEGIN SELECT RAISE(ABORT, 'receipt context is immutable'); END;

      -- ---------------------------------------------------------------------------------------
      -- Plan §D-5: the print-job journal. Device-local only -- never synced, no FK into any
      -- business table, no trigger on any business table. One row per requestId; the reservation
      -- and auto-print partial indexes are the concurrency arbiters (plan §D-5 C step 4).
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE receipt_print_jobs (
        job_uuid                    TEXT PRIMARY KEY,
        request_id                  TEXT NOT NULL UNIQUE,
        client_intent_json          TEXT NOT NULL,
        client_intent_sha256        TEXT NOT NULL CHECK (length(client_intent_sha256) = 64),
        trigger                     TEXT NOT NULL CHECK (trigger IN ('manual','auto','test')),

        owner_company_uuid          TEXT NOT NULL,
        owner_device_uuid           TEXT NOT NULL,
        requested_by_user_uuid      TEXT NOT NULL,
        session_epoch_at_claim      INTEGER NOT NULL CHECK (typeof(session_epoch_at_claim)='integer'),

        document_kind                TEXT NOT NULL CHECK (document_kind IN ('sale','refund','test')),
        document_local_uuid          TEXT NOT NULL,
        document_json                 TEXT NOT NULL CHECK (length(CAST(document_json AS BLOB)) <= 262144),
        document_sha256               TEXT NOT NULL CHECK (length(document_sha256) = 64),
        template_version              INTEGER NOT NULL CHECK (typeof(template_version)='integer'),
        locale                        TEXT NOT NULL CHECK (locale IN ('en','ar')),
        is_reprint                    INTEGER NOT NULL CHECK (is_reprint IN (0,1)),

        facts_projection              TEXT,
        transaction_facts_sha256      TEXT CHECK (transaction_facts_sha256 IS NULL OR length(transaction_facts_sha256) = 64),

        resolved_options_json         TEXT NOT NULL,
        options_sha256                TEXT NOT NULL CHECK (length(options_sha256) = 64),
        layout_json                   TEXT,
        layout_sha256                 TEXT,

        status                        TEXT NOT NULL CHECK (status IN
          ('queued','preparing','dispatching','submitted','cancelled','failed_before_dispatch','outcome_unknown')),
        cancel_origin                 TEXT CHECK (cancel_origin IN ('queue','dialog')),
        worker_lease_id               TEXT,
        dispatch_token                TEXT,
        failure_code                  TEXT,

        os_callback_at                TEXT,
        os_callback_success           INTEGER CHECK (os_callback_success IS NULL OR os_callback_success IN (0,1)),
        os_callback_reason            TEXT CHECK (os_callback_reason IS NULL OR length(os_callback_reason) <= 120),

        created_at                    TEXT NOT NULL,
        preparing_at                  TEXT,
        dispatched_at                 TEXT,
        unknown_at                    TEXT,
        finished_at                   TEXT,
        window_released_at            TEXT,

        CHECK ((dispatch_token IS NULL) = (dispatched_at IS NULL)),
        CHECK ((document_kind = 'test') = (transaction_facts_sha256 IS NULL)),
        CHECK (cancel_origin IS NULL OR cancel_origin <> 'queue' OR dispatched_at IS NULL),
        CHECK (cancel_origin IS NULL OR cancel_origin <> 'dialog' OR dispatched_at IS NOT NULL),
        CHECK ((status = 'cancelled') = (cancel_origin IS NOT NULL))
      ) STRICT;

      -- The reservation arbiter: at most one non-terminal job per document.
      CREATE UNIQUE INDEX idx_receipt_print_jobs_reservation
        ON receipt_print_jobs(document_kind, document_local_uuid)
        WHERE status IN ('queued','preparing','dispatching');

      -- The auto-print-once arbiter: at most one AUTO-triggered job ever, per document.
      CREATE UNIQUE INDEX idx_receipt_print_jobs_auto
        ON receipt_print_jobs(document_kind, document_local_uuid)
        WHERE trigger = 'auto';

      CREATE INDEX idx_receipt_print_jobs_document
        ON receipt_print_jobs(document_kind, document_local_uuid, created_at);

      -- Plan §D-5 E: only the listed (OLD.status -> NEW.status) pairs may ever be written. This is
      -- the primary database-level safety net for the transition contract; the repository layer
      -- additionally only ever issues the specific conditional UPDATE each transition defines.
      CREATE TRIGGER trg_receipt_print_jobs_status_transitions
      BEFORE UPDATE OF status ON receipt_print_jobs
      WHEN NOT (
        (OLD.status = 'queued' AND NEW.status IN ('preparing','cancelled','failed_before_dispatch'))
        OR (OLD.status = 'preparing' AND NEW.status IN ('cancelled','failed_before_dispatch','dispatching'))
        OR (OLD.status = 'dispatching' AND NEW.status IN ('submitted','outcome_unknown','cancelled','failed_before_dispatch'))
        OR (OLD.status = 'outcome_unknown' AND NEW.status = 'submitted')
      )
      BEGIN SELECT RAISE(ABORT, 'illegal receipt_print_jobs status transition'); END;

      CREATE TRIGGER trg_receipt_print_jobs_no_delete
      BEFORE DELETE ON receipt_print_jobs
      BEGIN SELECT RAISE(ABORT, 'receipt_print_jobs rows are retained'); END;
    `)
  }
}
