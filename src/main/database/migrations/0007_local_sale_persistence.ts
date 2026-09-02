import type { DatabaseMigration } from '../migrator'

// Phase 3F plan §5.3-§5.4 (revision 3, approved). Every table here is STRICT; every integer
// quantity/money column additionally carries typeof(x)='integer' because STRICT alone still
// coerces a numeric string. Forward-only and purely additive: no existing table is altered except
// `sync_queue`, which only gains a partial unique index (§5.4) — its own CREATE TABLE is untouched.
export const localSalePersistenceMigration: DatabaseMigration = {
  version: 7,
  name: 'local_sale_persistence',
  up(database) {
    database.exec(`
      CREATE TABLE sale_attempts (
        attempt_key         TEXT PRIMARY KEY,
        company_uuid        TEXT NOT NULL,
        device_uuid         TEXT NOT NULL,
        user_uuid           TEXT NOT NULL,
        claim_session_epoch INTEGER NOT NULL CHECK (typeof(claim_session_epoch)='integer' AND claim_session_epoch >= 1),
        origin_shift_uuid   TEXT NOT NULL,
        origin_shift_observed_at TEXT NOT NULL,
        origin_branch_uuid  TEXT NOT NULL,
        origin_warehouse_uuid TEXT NOT NULL,
        origin_context_fingerprint TEXT NOT NULL CHECK (length(origin_context_fingerprint) = 64),
        intent_fingerprint  TEXT NOT NULL CHECK (length(intent_fingerprint) = 64),
        intent_version      INTEGER NOT NULL DEFAULT 1 CHECK (typeof(intent_version)='integer' AND intent_version >= 1),
        -- Canonical JSON of the validated SaleCompletionIntent. CONTAINS AMOUNTS AND PAYMENT REFERENCES.
        -- Never tokens or credentials. D6-A purge: rejected/acknowledged/abandoned.
        intent_json         TEXT CHECK (intent_json IS NULL OR length(CAST(intent_json AS BLOB)) <= 65536),
        state               TEXT NOT NULL
          CHECK (state IN ('claimed','committed','rejected','acknowledged','abandoned')),
        invoice_local_uuid  TEXT REFERENCES local_invoices(local_uuid),
        failure_code        TEXT,
        claimed_at          TEXT NOT NULL,
        last_attempted_at   TEXT,
        committed_at        TEXT,
        rejected_at         TEXT,
        acknowledged_at     TEXT,
        abandoned_at        TEXT,
        updated_at          TEXT NOT NULL,
        CHECK ((state IN ('committed','acknowledged')) = (invoice_local_uuid IS NOT NULL)),
        CHECK ((state = 'rejected') = (failure_code IS NOT NULL)),
        CHECK (
          (state IN ('claimed','committed') AND intent_json IS NOT NULL)
          OR (state IN ('rejected','acknowledged','abandoned') AND intent_json IS NULL)
        ),
        CHECK ((state IN ('committed','acknowledged')) = (committed_at IS NOT NULL)),
        CHECK ((state = 'rejected') = (rejected_at IS NOT NULL)),
        CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
        CHECK ((state = 'abandoned') = (abandoned_at IS NOT NULL)),
        CHECK (state NOT IN ('committed','acknowledged','rejected') OR last_attempted_at IS NOT NULL)
      ) STRICT;

      -- At most one blocking attempt per (company, device, cashier). Probe P6/P7.
      CREATE UNIQUE INDEX idx_sale_attempts_one_blocking
        ON sale_attempts(company_uuid, device_uuid, user_uuid) WHERE state = 'claimed';
      CREATE INDEX idx_sale_attempts_owner_state
        ON sale_attempts(company_uuid, device_uuid, user_uuid, state, committed_at, attempt_key);

      CREATE TABLE local_invoices (
        local_uuid            TEXT PRIMARY KEY,               -- == idempotency_key sent to Laravel
        attempt_key           TEXT NOT NULL UNIQUE REFERENCES sale_attempts(attempt_key),
        offline_number        TEXT NOT NULL UNIQUE,           -- LOCAL ONLY, never fiscal
        remote_uuid           TEXT UNIQUE,
        server_number         TEXT,
        sync_status           TEXT NOT NULL DEFAULT 'pending'
          CHECK (sync_status IN ('pending','uploading','synced','retryable_error','conflict','rejected')),
        sync_attempts         INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(sync_attempts)='integer' AND sync_attempts >= 0),
        last_sync_error       TEXT,
        synced_at             TEXT,

        company_uuid          TEXT NOT NULL,
        branch_uuid           TEXT NOT NULL,                  -- copied from attempt origin
        warehouse_uuid        TEXT NOT NULL,                  -- copied from attempt origin
        device_uuid           TEXT NOT NULL,
        user_uuid             TEXT NOT NULL,
        shift_uuid            TEXT NOT NULL,                  -- copied from attempt origin
        commit_session_epoch  INTEGER NOT NULL CHECK (typeof(commit_session_epoch)='integer' AND commit_session_epoch >= 1),

        catalog_revision      TEXT NOT NULL CHECK (length(catalog_revision) = 64),
        intent_fingerprint    TEXT NOT NULL CHECK (length(intent_fingerprint) = 64),
        customer_uuid         TEXT,
        currency              TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
        currency_exponent     INTEGER NOT NULL
          CHECK (typeof(currency_exponent)='integer' AND currency_exponent BETWEEN 0 AND 3),
        tax_mode              TEXT NOT NULL CHECK (tax_mode IN ('none','inclusive','exclusive')),

        invoice_discount_type  TEXT CHECK (invoice_discount_type IN ('fixed','percentage')),
        invoice_discount_value INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(invoice_discount_value)='integer' AND invoice_discount_value >= 0),

        subtotal_amount       INTEGER NOT NULL CHECK (typeof(subtotal_amount)='integer'       AND subtotal_amount       BETWEEN 0 AND 900000000000000),
        discount_total_amount INTEGER NOT NULL CHECK (typeof(discount_total_amount)='integer' AND discount_total_amount BETWEEN 0 AND 900000000000000),
        tax_total_amount      INTEGER NOT NULL CHECK (typeof(tax_total_amount)='integer'      AND tax_total_amount      BETWEEN 0 AND 900000000000000),
        grand_total_amount    INTEGER NOT NULL CHECK (typeof(grand_total_amount)='integer'    AND grand_total_amount    BETWEEN 0 AND 900000000000000),
        paid_total_amount     INTEGER NOT NULL CHECK (typeof(paid_total_amount)='integer'     AND paid_total_amount     BETWEEN 0 AND 900000000000000),
        change_due_amount     INTEGER NOT NULL CHECK (typeof(change_due_amount)='integer'     AND change_due_amount     >= 0),
        due_amount            INTEGER NOT NULL DEFAULT 0 CHECK (due_amount = 0),   -- no credit sales in 3F

        sold_at               TEXT NOT NULL,
        connectivity_state_at_sale TEXT NOT NULL
          CHECK (connectivity_state_at_sale IN ('online','offline','unknown')),
        sold_while_offline    INTEGER NOT NULL CHECK (sold_while_offline IN (0,1)),
        notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 1000),

        commercial_snapshot_json TEXT NOT NULL,     -- receipt/audit only; never uploaded
        upload_payload_version   INTEGER NOT NULL DEFAULT 2
          CHECK (typeof(upload_payload_version)='integer' AND upload_payload_version >= 1),

        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        CHECK (invoice_discount_type IS NOT NULL OR invoice_discount_value = 0),
        CHECK (invoice_discount_type <> 'percentage' OR invoice_discount_value <= 10000),
        CHECK (
          (connectivity_state_at_sale = 'online' AND sold_while_offline = 0)
          OR (connectivity_state_at_sale IN ('offline','unknown') AND sold_while_offline = 1)
        ),
        CHECK ((sync_status = 'synced') = (synced_at IS NOT NULL)),
        CHECK (sync_status = 'synced' OR remote_uuid IS NULL)
      ) STRICT;
      CREATE INDEX idx_local_invoices_sync_status ON local_invoices(sync_status, created_at);
      CREATE INDEX idx_local_invoices_sold_at     ON local_invoices(sold_at);

      CREATE TABLE local_invoice_items (
        local_uuid           TEXT PRIMARY KEY,
        invoice_local_uuid   TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        line_index           INTEGER NOT NULL CHECK (typeof(line_index)='integer' AND line_index >= 0),
        product_uuid         TEXT NOT NULL,
        product_name         TEXT NOT NULL,
        sku                  TEXT,
        barcode               TEXT,
        unit                 TEXT,
        track_stock          INTEGER NOT NULL CHECK (track_stock IN (0,1)),
        quantity_milli       INTEGER NOT NULL CHECK (typeof(quantity_milli)='integer' AND quantity_milli BETWEEN 1 AND 999999999),
        unit_price_amount    INTEGER NOT NULL CHECK (typeof(unit_price_amount)='integer' AND unit_price_amount BETWEEN 0 AND 1000000000),
        currency             TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
        price_revision       TEXT NOT NULL CHECK (length(price_revision) = 64),
        tax_uuid              TEXT,
        tax_mode              TEXT NOT NULL CHECK (tax_mode IN ('none','inclusive','exclusive')),
        tax_rate_basis_points INTEGER NOT NULL CHECK (typeof(tax_rate_basis_points)='integer' AND tax_rate_basis_points BETWEEN 0 AND 10000),
        tax_revision          TEXT NOT NULL CHECK (length(tax_revision) = 64),
        discount_type         TEXT CHECK (discount_type IN ('fixed','percentage')),
        discount_value        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount_value)='integer' AND discount_value >= 0),
        subtotal_amount       INTEGER NOT NULL CHECK (typeof(subtotal_amount)='integer' AND subtotal_amount BETWEEN 0 AND 900000000000000),
        discount_amount       INTEGER NOT NULL CHECK (typeof(discount_amount)='integer' AND discount_amount >= 0),
        tax_amount            INTEGER NOT NULL CHECK (typeof(tax_amount)='integer'      AND tax_amount      >= 0),
        total_amount          INTEGER NOT NULL CHECK (typeof(total_amount)='integer'    AND total_amount    >= 0),
        created_at            TEXT NOT NULL,
        UNIQUE (invoice_local_uuid, line_index),
        CHECK (discount_type IS NOT NULL OR discount_value = 0),
        CHECK (discount_type <> 'percentage' OR discount_value <= 10000),
        CHECK (discount_type <> 'fixed' OR discount_value <= subtotal_amount),
        CHECK (tax_mode <> 'none' OR tax_rate_basis_points = 0),
        CHECK (discount_amount <= subtotal_amount)
      ) STRICT;
      CREATE INDEX idx_local_invoice_items_invoice ON local_invoice_items(invoice_local_uuid, line_index);

      CREATE TABLE local_invoice_payments (
        local_uuid           TEXT PRIMARY KEY,
        invoice_local_uuid   TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        payment_index        INTEGER NOT NULL CHECK (typeof(payment_index)='integer' AND payment_index >= 0),
        payment_method_uuid  TEXT NOT NULL,
        type                 TEXT NOT NULL CHECK (type IN ('cash','card','other')),
        amount               INTEGER NOT NULL CHECK (typeof(amount)='integer' AND amount BETWEEN 0 AND 900000000000000),
        reference            TEXT CHECK (reference IS NULL OR (length(reference) BETWEEN 1 AND 255 AND trim(reference) = reference)),
        requires_reference   INTEGER NOT NULL CHECK (requires_reference IN (0,1)),
        paid_at              TEXT NOT NULL,
        method_snapshot_json TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        UNIQUE (invoice_local_uuid, payment_index),
        CHECK (requires_reference = 0 OR (reference IS NOT NULL AND length(trim(reference)) > 0))
      ) STRICT;
      CREATE INDEX idx_local_invoice_payments_invoice ON local_invoice_payments(invoice_local_uuid, payment_index);

      CREATE TABLE stock_allocation_grants (
        allocation_uuid       TEXT PRIMARY KEY,
        contract_version      INTEGER NOT NULL
          CHECK (typeof(contract_version)='integer' AND contract_version >= 1),
        company_uuid          TEXT NOT NULL,
        device_uuid           TEXT NOT NULL,
        warehouse_uuid        TEXT NOT NULL,
        product_uuid          TEXT NOT NULL,
        server_sequence       INTEGER NOT NULL
          CHECK (typeof(server_sequence)='integer' AND server_sequence >= 1),
        lifecycle_generation  INTEGER NOT NULL
          CHECK (typeof(lifecycle_generation)='integer' AND lifecycle_generation >= 1),
        granted_quantity_milli INTEGER NOT NULL
          CHECK (typeof(granted_quantity_milli)='integer' AND granted_quantity_milli > 0),
        consume_until         TEXT NOT NULL,
        status                TEXT NOT NULL
          CHECK (status IN ('active','sealed','consumed','released','expired')),
        envelope_hash         TEXT NOT NULL CHECK (length(envelope_hash) = 64),
        final_consumption_sequence INTEGER
          CHECK (final_consumption_sequence IS NULL OR
                 (typeof(final_consumption_sequence)='integer' AND final_consumption_sequence >= 0)),
        final_consumption_hash TEXT
          CHECK (final_consumption_hash IS NULL OR length(final_consumption_hash) = 64),
        received_at           TEXT NOT NULL,
        sealed_at             TEXT,
        finalized_at          TEXT,
        updated_at            TEXT NOT NULL,
        CHECK ((status = 'active') = (sealed_at IS NULL)),
        CHECK (
          (status = 'released' AND final_consumption_sequence IS NOT NULL
                               AND final_consumption_hash IS NOT NULL
                               AND finalized_at IS NOT NULL)
          OR (status <> 'released' AND final_consumption_sequence IS NULL
                                  AND final_consumption_hash IS NULL
                                  AND finalized_at IS NULL)
        )
      ) STRICT;
      CREATE INDEX idx_stock_allocation_grants_available
        ON stock_allocation_grants(company_uuid, device_uuid, warehouse_uuid, product_uuid, status,
                                   consume_until, server_sequence, allocation_uuid);

      CREATE TABLE local_stock_allocation_consumptions (
        local_uuid            TEXT PRIMARY KEY,
        allocation_uuid       TEXT NOT NULL REFERENCES stock_allocation_grants(allocation_uuid),
        consumption_sequence  INTEGER NOT NULL
          CHECK (typeof(consumption_sequence)='integer' AND consumption_sequence >= 1),
        invoice_local_uuid    TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        item_local_uuid       TEXT NOT NULL REFERENCES local_invoice_items(local_uuid),
        quantity_milli        INTEGER NOT NULL
          CHECK (typeof(quantity_milli)='integer' AND quantity_milli > 0),
        server_status         TEXT NOT NULL DEFAULT 'pending'
          CHECK (server_status IN ('pending','acknowledged')),
        server_consumption_uuid TEXT UNIQUE,
        acknowledged_at       TEXT,
        created_at            TEXT NOT NULL,
        UNIQUE (allocation_uuid, consumption_sequence),
        UNIQUE (invoice_local_uuid, item_local_uuid, allocation_uuid),
        CHECK ((server_status = 'acknowledged') = (acknowledged_at IS NOT NULL)),
        CHECK ((server_status = 'acknowledged') = (server_consumption_uuid IS NOT NULL))
      ) STRICT;
      CREATE INDEX idx_local_allocation_consumptions_grant
        ON local_stock_allocation_consumptions(allocation_uuid, server_status, created_at);
      CREATE INDEX idx_local_allocation_consumptions_invoice
        ON local_stock_allocation_consumptions(invoice_local_uuid, item_local_uuid);

      CREATE TABLE local_stock_movements (
        local_uuid           TEXT PRIMARY KEY,
        invoice_local_uuid   TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        item_local_uuid      TEXT NOT NULL UNIQUE REFERENCES local_invoice_items(local_uuid),
        product_uuid         TEXT NOT NULL,
        warehouse_uuid       TEXT NOT NULL,
        direction            TEXT NOT NULL CHECK (direction = 'out'),
        quantity_milli       INTEGER NOT NULL CHECK (typeof(quantity_milli)='integer' AND quantity_milli > 0),
        -- 'synced' FORBIDDEN in 3F: inclusion is unproven (§3.7). Widening requires BE-3F-4.
        sync_status          TEXT NOT NULL DEFAULT 'pending'
          CHECK (sync_status IN ('pending','uploading','retryable_error','conflict','rejected')),
        synced_at            TEXT CHECK (synced_at IS NULL),
        created_at           TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_local_stock_movements_projection ON local_stock_movements(product_uuid, warehouse_uuid, sync_status);
      CREATE INDEX idx_local_stock_movements_invoice    ON local_stock_movements(invoice_local_uuid);

      -- Additive change to the shipped sync_queue: no shipped migration is edited.
      CREATE UNIQUE INDEX idx_sync_queue_invoice_upload
        ON sync_queue(aggregate_type, local_aggregate_uuid, operation)
        WHERE aggregate_type = 'invoice' AND operation = 'upload';
    `)
  }
}
