import type { DatabaseMigration } from '../migrator'

/**
 * PS4 — durable local state for physical-presence offline selling (plan §6, §7.1, §15.3).
 *
 * ## Why this migration rebuilds `local_invoice_items`
 *
 * The covered/uncovered split needs a CHECK tying it to the line quantity, and SQLite cannot add a
 * CHECK to an existing table — it needs the 12-step rebuild. `local_invoice_items` is FK-referenced
 * by `local_stock_movements` and `local_stock_allocation_consumptions`, so the rebuild runs under
 * the existing `rebuildsForeignKeyReferencedTable` flag that migration 0009 already established.
 *
 * The naive constraint is unsatisfiable on a populated database:
 *
 * ```sql
 * CHECK (allocation_covered_milli + uncovered_milli = quantity_milli)   -- WRONG
 * ```
 *
 * An untracked line has no consumptions at all, so its split is `0 + 0 = 0`, which never equals its
 * quantity. The constraint is therefore conditional on `track_stock`, and the backfill gives tracked
 * rows `covered = quantity_milli, uncovered = 0` (every pre-PS4 tracked line was fully
 * allocation-covered by construction — that was the only way it could have committed) and untracked
 * rows `0, 0`.
 *
 * ## The authority is stored, never inferred
 *
 * `offline_sale_authorities` holds what the server issued, verbatim. The desktop never mints one,
 * never extends one, and never infers one from the absence of an error. A device that has never
 * negotiated an authority has no row here and therefore behaves exactly as it does today — which is
 * the property that makes PS4 safe to ship before any backend is configured.
 */
export const offlineSalePolicyMigration: DatabaseMigration = {
  version: 12,
  name: 'offline_sale_policy',
  // `local_invoice_items` is FK-referenced, so the rebuild below needs foreign keys disabled around
  // the migration's own transaction — the same path migration 0009 uses.
  rebuildsForeignKeyReferencedTable: true,
  up(database): void {
    database.exec(`
      -- ---------------------------------------------------------------------------------------
      -- The server-issued offline-sale authority (§6.2)
      -- ---------------------------------------------------------------------------------------
      -- One row per authority the server has published to this device. Never generated locally.
      --
      -- not_after is stored as the server computed it under the §6.3a formula, already clipped to
      -- the 72-hour ceiling and every earlier boundary. The desktop only ever COMPARES against it;
      -- it never recomputes it, because doing so would mean trusting the client's own clock and
      -- plan knowledge to decide how long it may sell.
      CREATE TABLE offline_sale_authorities (
        authority_uuid     TEXT PRIMARY KEY,
        company_uuid       TEXT NOT NULL,
        device_uuid        TEXT NOT NULL,
        mode               TEXT NOT NULL CHECK (mode IN ('allocation_exclusive','physical_presence')),
        policy_revision    INTEGER NOT NULL CHECK (typeof(policy_revision)='integer' AND policy_revision > 0),
        contract_version   INTEGER NOT NULL CHECK (typeof(contract_version)='integer' AND contract_version >= 1),
        issued_at          TEXT NOT NULL,
        not_before         TEXT NOT NULL,
        not_after          TEXT NOT NULL,
        authority_hash     TEXT NOT NULL CHECK (length(authority_hash) = 64),
        -- The instant this device last saw the authority republished. Diagnostic only: it is NOT a
        -- renewal, and it never moves not_after. §14.3 — the window never resets on launch,
        -- navigation, a refresh-only cycle, a retry, or a clock rollback.
        observed_at        TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        CHECK (not_before < not_after)
      ) STRICT;
      CREATE INDEX idx_offline_sale_authorities_window
        ON offline_sale_authorities(company_uuid, device_uuid, not_after);

      -- ---------------------------------------------------------------------------------------
      -- Invoice-level record of what authorized the sale
      -- ---------------------------------------------------------------------------------------
      ALTER TABLE local_invoices ADD COLUMN offline_sale_authority_uuid TEXT
        REFERENCES offline_sale_authorities(authority_uuid);
      ALTER TABLE local_invoices ADD COLUMN stock_authorization_policy TEXT
        CHECK (stock_authorization_policy IS NULL
               OR stock_authorization_policy IN ('allocation_exclusive','physical_presence'));

      ALTER TABLE local_stock_movements ADD COLUMN stock_authorization TEXT
        CHECK (stock_authorization IS NULL
               OR stock_authorization IN ('allocation','physical_presence','mixed'));

      -- ---------------------------------------------------------------------------------------
      -- The per-line covered/uncovered split (§8.4, §15.3) — 12-step rebuild
      -- ---------------------------------------------------------------------------------------
      CREATE TABLE local_invoice_items_ps4 (
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

        -- The PS4 split. Both default to 0 so the rebuild's INSERT ... SELECT can compute them.
        allocation_covered_milli INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(allocation_covered_milli)='integer' AND allocation_covered_milli >= 0),
        uncovered_milli          INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(uncovered_milli)='integer' AND uncovered_milli >= 0),

        created_at            TEXT NOT NULL,
        UNIQUE (invoice_local_uuid, line_index),
        CHECK (discount_type IS NOT NULL OR discount_value = 0),
        CHECK (discount_type <> 'percentage' OR discount_value <= 10000),
        CHECK (discount_type <> 'fixed' OR discount_value <= subtotal_amount),
        CHECK (tax_mode <> 'none' OR tax_rate_basis_points = 0),
        CHECK (discount_amount <= subtotal_amount),

        -- §15.3: conditional on track_stock. An untracked line has no consumptions and no
        -- remainder, so an unconditional equality would fail on the very first populated migration.
        CHECK (track_stock = 0
               OR allocation_covered_milli + uncovered_milli = quantity_milli)
      ) STRICT;

      INSERT INTO local_invoice_items_ps4 (
        local_uuid, invoice_local_uuid, line_index, product_uuid, product_name, sku, barcode, unit,
        track_stock, quantity_milli, unit_price_amount, currency, price_revision, tax_uuid, tax_mode,
        tax_rate_basis_points, tax_revision, discount_type, discount_value, subtotal_amount,
        discount_amount, tax_amount, total_amount, allocation_covered_milli, uncovered_milli, created_at
      )
      SELECT
        local_uuid, invoice_local_uuid, line_index, product_uuid, product_name, sku, barcode, unit,
        track_stock, quantity_milli, unit_price_amount, currency, price_revision, tax_uuid, tax_mode,
        tax_rate_basis_points, tax_revision, discount_type, discount_value, subtotal_amount,
        discount_amount, tax_amount, total_amount,
        -- Every pre-PS4 tracked line was fully allocation-covered: that was the only way it could
        -- have committed at all, since the local invariant required exact coverage. Backfilling it
        -- as such records what actually happened rather than inventing a remainder.
        CASE WHEN track_stock = 1 THEN quantity_milli ELSE 0 END,
        0,
        created_at
      FROM local_invoice_items;

      DROP TABLE local_invoice_items;
      ALTER TABLE local_invoice_items_ps4 RENAME TO local_invoice_items;
      CREATE INDEX idx_local_invoice_items_invoice ON local_invoice_items(invoice_local_uuid, line_index);
    `)

    // A populated rebuild must not have silently dropped a referenced row. Checked here rather than
    // trusted, because a broken FK graph would surface much later as an unexplained missing line.
    const violations = database.pragma('foreign_key_check') as unknown[]

    if (violations.length > 0) {
      throw new Error(
        `0012_offline_sale_policy left ${violations.length} foreign key violation(s) after rebuilding local_invoice_items.`
      )
    }
  }
}
