import type { DatabaseMigration } from '../migrator'

/**
 * POS improvements, Stage 4 — mixed tax configurations in one sale.
 *
 * - `catalog_metadata.mixed_tax_mode_policy` admits `per_line`, the policy a backend issues only to a
 *   register that negotiated `catalog_tax_policy_version=2`. SQLite cannot widen a CHECK in place, so
 *   the single-row table is rebuilt (nothing references it).
 * - `catalog_products.tax_category` / `local_invoice_items.tax_category`: standard, zero_rated or
 *   exempt, or NULL for "unspecified (legacy)". The item value is frozen from the installed catalog at
 *   commit and is never back-filled or inferred.
 * - `local_invoices.tax_mode` admits `mixed`: the HEADER of a sale whose lines carry two or more
 *   modes (uploaded as v4/v5). A line is never `mixed` — `local_invoice_items` keeps its CHECK.
 *   `local_invoices` is FK-referenced (items, payments, movements, consumptions, refunds, receipt
 *   context, disposition rows, sale attempts), so the 12-step rebuild runs under
 *   `rebuildsForeignKeyReferencedTable`, like migrations 0009 and 0012. The column list and order,
 *   every other CHECK, and all three indexes are reproduced exactly; rows are copied unchanged.
 */
export const mixedTaxMigration: DatabaseMigration = {
  version: 22,
  name: 'mixed_tax',
  rebuildsForeignKeyReferencedTable: true,
  up(database): void {
    database.exec(`
      CREATE TABLE catalog_metadata_v22 (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision TEXT NOT NULL UNIQUE,
        generated_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        quantity_scale INTEGER NOT NULL CHECK (quantity_scale = 3),
        minimum_quantity TEXT NOT NULL,
        maximum_quantity TEXT NOT NULL,
        maximum_unit_price INTEGER NOT NULL CHECK (maximum_unit_price > 0),
        maximum_line_total INTEGER NOT NULL CHECK (maximum_line_total > 0),
        maximum_invoice_total INTEGER NOT NULL CHECK (maximum_invoice_total > 0),
        mixed_tax_mode_policy TEXT NOT NULL
          CHECK (mixed_tax_mode_policy IN ('single_invoice_mode', 'per_line')),
        fetched_at TEXT NOT NULL,
        expected_counts_json TEXT NOT NULL DEFAULT '{}',
        is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
        currency_exponent INTEGER NOT NULL DEFAULT 2 CHECK (currency_exponent BETWEEN 0 AND 3)
      );
      INSERT INTO catalog_metadata_v22 (
        id, revision, generated_at, valid_until, quantity_scale, minimum_quantity, maximum_quantity,
        maximum_unit_price, maximum_line_total, maximum_invoice_total, mixed_tax_mode_policy,
        fetched_at, expected_counts_json, is_complete, currency, currency_exponent
      )
      SELECT
        id, revision, generated_at, valid_until, quantity_scale, minimum_quantity, maximum_quantity,
        maximum_unit_price, maximum_line_total, maximum_invoice_total, mixed_tax_mode_policy,
        fetched_at, expected_counts_json, is_complete, currency, currency_exponent
      FROM catalog_metadata;
      DROP TABLE catalog_metadata;
      ALTER TABLE catalog_metadata_v22 RENAME TO catalog_metadata;

      ALTER TABLE catalog_products ADD COLUMN tax_category TEXT
        CHECK (tax_category IS NULL OR tax_category IN ('standard', 'zero_rated', 'exempt'));

      ALTER TABLE local_invoice_items ADD COLUMN tax_category TEXT
        CHECK (tax_category IS NULL OR tax_category IN ('standard', 'zero_rated', 'exempt'));

      CREATE TABLE local_invoices_v22 (
        local_uuid            TEXT PRIMARY KEY,
        attempt_key           TEXT NOT NULL UNIQUE REFERENCES sale_attempts(attempt_key),
        offline_number        TEXT NOT NULL UNIQUE,
        remote_uuid           TEXT UNIQUE,
        server_number         TEXT,
        sync_status           TEXT NOT NULL DEFAULT 'pending'
          CHECK (sync_status IN ('pending','uploading','synced','retryable_error','conflict','rejected')),
        sync_attempts         INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(sync_attempts)='integer' AND sync_attempts >= 0),
        last_sync_error       TEXT,
        synced_at             TEXT,

        company_uuid          TEXT NOT NULL,
        branch_uuid           TEXT NOT NULL,
        warehouse_uuid        TEXT NOT NULL,
        device_uuid           TEXT NOT NULL,
        user_uuid             TEXT NOT NULL,
        shift_uuid            TEXT NOT NULL,
        commit_session_epoch  INTEGER NOT NULL CHECK (typeof(commit_session_epoch)='integer' AND commit_session_epoch >= 1),

        catalog_revision      TEXT NOT NULL CHECK (length(catalog_revision) = 64),
        intent_fingerprint    TEXT NOT NULL CHECK (length(intent_fingerprint) = 64),
        customer_uuid         TEXT,
        currency              TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
        currency_exponent     INTEGER NOT NULL
          CHECK (typeof(currency_exponent)='integer' AND currency_exponent BETWEEN 0 AND 3),
        -- Stage 4: 'mixed' is the header of a sale whose lines carry two or more modes.
        tax_mode              TEXT NOT NULL CHECK (tax_mode IN ('none','inclusive','exclusive','mixed')),

        invoice_discount_type  TEXT CHECK (invoice_discount_type IN ('fixed','percentage')),
        invoice_discount_value INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(invoice_discount_value)='integer' AND invoice_discount_value >= 0),

        subtotal_amount       INTEGER NOT NULL CHECK (typeof(subtotal_amount)='integer'       AND subtotal_amount       BETWEEN 0 AND 900000000000000),
        discount_total_amount INTEGER NOT NULL CHECK (typeof(discount_total_amount)='integer' AND discount_total_amount BETWEEN 0 AND 900000000000000),
        tax_total_amount      INTEGER NOT NULL CHECK (typeof(tax_total_amount)='integer'      AND tax_total_amount      BETWEEN 0 AND 900000000000000),
        grand_total_amount    INTEGER NOT NULL CHECK (typeof(grand_total_amount)='integer'    AND grand_total_amount    BETWEEN 0 AND 900000000000000),
        paid_total_amount     INTEGER NOT NULL CHECK (typeof(paid_total_amount)='integer'     AND paid_total_amount     BETWEEN 0 AND 900000000000000),
        change_due_amount     INTEGER NOT NULL CHECK (typeof(change_due_amount)='integer'     AND change_due_amount     >= 0),
        due_amount            INTEGER NOT NULL DEFAULT 0 CHECK (due_amount = 0),

        sold_at               TEXT NOT NULL,
        connectivity_state_at_sale TEXT NOT NULL
          CHECK (connectivity_state_at_sale IN ('online','offline','unknown')),
        sold_while_offline    INTEGER NOT NULL CHECK (sold_while_offline IN (0,1)),
        notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 1000),

        commercial_snapshot_json TEXT NOT NULL,
        upload_payload_version   INTEGER NOT NULL DEFAULT 2
          CHECK (typeof(upload_payload_version)='integer' AND upload_payload_version >= 1),

        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        offline_sale_authority_uuid TEXT
          REFERENCES offline_sale_authorities(authority_uuid),
        stock_authorization_policy TEXT
          CHECK (stock_authorization_policy IS NULL
                 OR stock_authorization_policy IN ('allocation_exclusive','physical_presence')),
        CHECK (invoice_discount_type IS NOT NULL OR invoice_discount_value = 0),
        CHECK (invoice_discount_type <> 'percentage' OR invoice_discount_value <= 10000),
        CHECK (
          (connectivity_state_at_sale = 'online' AND sold_while_offline = 0)
          OR (connectivity_state_at_sale IN ('offline','unknown') AND sold_while_offline = 1)
        ),
        CHECK ((sync_status = 'synced') = (synced_at IS NOT NULL)),
        CHECK (sync_status = 'synced' OR remote_uuid IS NULL)
      ) STRICT;
      INSERT INTO local_invoices_v22 (
        local_uuid, attempt_key, offline_number, remote_uuid, server_number, sync_status,
        sync_attempts, last_sync_error, synced_at, company_uuid, branch_uuid, warehouse_uuid,
        device_uuid, user_uuid, shift_uuid, commit_session_epoch, catalog_revision,
        intent_fingerprint, customer_uuid, currency, currency_exponent, tax_mode,
        invoice_discount_type, invoice_discount_value, subtotal_amount, discount_total_amount,
        tax_total_amount, grand_total_amount, paid_total_amount, change_due_amount, due_amount,
        sold_at, connectivity_state_at_sale, sold_while_offline, notes, commercial_snapshot_json,
        upload_payload_version, created_at, updated_at, offline_sale_authority_uuid,
        stock_authorization_policy
      )
      SELECT
        local_uuid, attempt_key, offline_number, remote_uuid, server_number, sync_status,
        sync_attempts, last_sync_error, synced_at, company_uuid, branch_uuid, warehouse_uuid,
        device_uuid, user_uuid, shift_uuid, commit_session_epoch, catalog_revision,
        intent_fingerprint, customer_uuid, currency, currency_exponent, tax_mode,
        invoice_discount_type, invoice_discount_value, subtotal_amount, discount_total_amount,
        tax_total_amount, grand_total_amount, paid_total_amount, change_due_amount, due_amount,
        sold_at, connectivity_state_at_sale, sold_while_offline, notes, commercial_snapshot_json,
        upload_payload_version, created_at, updated_at, offline_sale_authority_uuid,
        stock_authorization_policy
      FROM local_invoices;
      DROP TABLE local_invoices;
      ALTER TABLE local_invoices_v22 RENAME TO local_invoices;
      CREATE INDEX idx_local_invoices_sync_status ON local_invoices(sync_status, created_at);
      CREATE INDEX idx_local_invoices_sold_at     ON local_invoices(sold_at);
      CREATE UNIQUE INDEX idx_local_invoices_owner ON local_invoices(local_uuid, company_uuid);
    `)
  }
}
