import type { DatabaseMigration } from '../migrator'

/**
 * Plan §3a (r5) — durable local refund identity, following the 0007 conventions: every table
 * STRICT, every integer money/quantity column additionally carrying `typeof(x)='integer'` because
 * STRICT alone still coerces a numeric string.
 *
 * ## Why a request-body column at all
 *
 * The backend refund endpoint is online-only and durable across a lost response: a refund must be
 * dispatched at most once with a given identity, and resumed with byte-identical bytes if the first
 * attempt's outcome is unknown. `request_json` freezes exactly what was reviewed and dispatched —
 * never rebuilt from a fresher read on resume — and `request_sha256` is a LOCAL integrity digest
 * over those bytes, distinct from and never compared against the backend's own request hash (plan
 * §3b "Local hash vs backend hash").
 *
 * ## The state machine (plan §3b)
 *
 * `prepared` (nothing sent yet, `dispatch_count = 0`) -> `dispatched` (in flight, outcome unknown)
 * -> one of `accepted` / `rejected` / `conflict` / `unresolved`. `unresolved` can return to
 * `dispatched` on resume. `prepared` can also go straight to `cancelled`, but ONLY while
 * `dispatch_count = 0` — the CHECK constraints make "cancelled but actually dispatched" impossible
 * to persist, and cancel-vs-dispatch races through one conditional UPDATE in the repository, never
 * through application-level locking alone.
 *
 * `conflict` stays inside the "one open refund per invoice" hold (below): an unknown outcome must
 * keep blocking a replacement, exactly as the plan requires.
 */
export const localRefundsMigration: DatabaseMigration = {
  version: 14,
  name: 'local_refunds',
  up(database) {
    database.exec(`
      CREATE TABLE local_refunds (
        local_uuid             TEXT PRIMARY KEY,               -- == idempotency_key == local_refund_uuid sent to Laravel
        invoice_local_uuid     TEXT NOT NULL REFERENCES local_invoices(local_uuid),
        invoice_remote_uuid    TEXT NOT NULL,

        company_uuid           TEXT NOT NULL,
        device_uuid            TEXT NOT NULL,
        user_uuid              TEXT NOT NULL,
        shift_uuid              TEXT NOT NULL,

        currency               TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
        currency_exponent      INTEGER NOT NULL
          CHECK (typeof(currency_exponent)='integer' AND currency_exponent BETWEEN 0 AND 3),

        subtotal_amount        INTEGER NOT NULL CHECK (typeof(subtotal_amount)='integer'       AND subtotal_amount       BETWEEN 0 AND 900000000000000),
        discount_total_amount  INTEGER NOT NULL CHECK (typeof(discount_total_amount)='integer' AND discount_total_amount BETWEEN 0 AND 900000000000000),
        tax_total_amount       INTEGER NOT NULL CHECK (typeof(tax_total_amount)='integer'      AND tax_total_amount      BETWEEN 0 AND 900000000000000),
        grand_total_amount     INTEGER NOT NULL CHECK (typeof(grand_total_amount)='integer'    AND grand_total_amount    BETWEEN 1 AND 900000000000000),

        refunded_at             TEXT NOT NULL,
        stock_returned          INTEGER NOT NULL CHECK (stock_returned IN (0,1)),
        reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 255),
        notes                   TEXT CHECK (notes IS NULL OR length(notes) <= 1000),

        -- The exact bytes reviewed and dispatched (or about to be). Never rebuilt on resume.
        -- Bounded the same way local_invoices.intent_json is bounded.
        request_json            TEXT NOT NULL CHECK (length(CAST(request_json AS BLOB)) <= 65536),
        request_sha256          TEXT NOT NULL CHECK (length(request_sha256) = 64),
        preview_id               TEXT NOT NULL,

        dispatch_count           INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(dispatch_count)='integer' AND dispatch_count >= 0),

        submission_state         TEXT NOT NULL DEFAULT 'prepared'
          CHECK (submission_state IN ('prepared','dispatched','unresolved','accepted','rejected','conflict','cancelled')),

        remote_uuid               TEXT UNIQUE,
        refund_number             TEXT,

        cancelled_at               TEXT,
        cancelled_reason           TEXT,
        last_error_code            TEXT,
        last_error_details         TEXT,

        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL,

        CHECK ((submission_state = 'accepted')  = (remote_uuid   IS NOT NULL)),
        CHECK ((submission_state = 'cancelled') = (cancelled_at  IS NOT NULL)),
        CHECK (submission_state <> 'prepared'  OR dispatch_count = 0),
        CHECK (submission_state <> 'cancelled' OR dispatch_count = 0),
        CHECK (submission_state IN ('prepared','cancelled') OR dispatch_count >= 1)
      ) STRICT;

      CREATE INDEX idx_local_refunds_invoice ON local_refunds(invoice_local_uuid, submission_state);
      CREATE INDEX idx_local_refunds_state   ON local_refunds(submission_state, created_at);

      -- The durable overlap invariant (plan §3a): at most one OPEN refund operation per invoice.
      -- 'conflict' stays inside this set on purpose -- an unknown outcome must keep blocking a
      -- replacement refund for the same invoice. 'cancelled', 'accepted' and 'rejected' are proven
      -- outcomes and do not block. No new idempotency key can bypass this: the index key is the
      -- invoice, not the refund's own identity.
      CREATE UNIQUE INDEX idx_local_refunds_one_open
        ON local_refunds(invoice_local_uuid)
        WHERE submission_state IN ('prepared','dispatched','unresolved','conflict');

      CREATE TABLE local_refund_items (
        local_uuid                    TEXT PRIMARY KEY,
        refund_local_uuid             TEXT NOT NULL REFERENCES local_refunds(local_uuid),
        line_index                    INTEGER NOT NULL CHECK (typeof(line_index)='integer' AND line_index >= 0),

        invoice_item_remote_uuid      TEXT NOT NULL,
        product_uuid                  TEXT NOT NULL,
        product_name                  TEXT NOT NULL,

        quantity_milli                INTEGER NOT NULL CHECK (typeof(quantity_milli)='integer' AND quantity_milli BETWEEN 1 AND 999999999),
        prior_refunded_quantity_milli INTEGER NOT NULL
          CHECK (typeof(prior_refunded_quantity_milli)='integer' AND prior_refunded_quantity_milli >= 0),

        subtotal_amount                INTEGER NOT NULL CHECK (typeof(subtotal_amount)='integer' AND subtotal_amount >= 0),
        discount_amount                INTEGER NOT NULL CHECK (typeof(discount_amount)='integer' AND discount_amount >= 0),
        tax_amount                     INTEGER NOT NULL CHECK (typeof(tax_amount)='integer'      AND tax_amount      >= 0),
        total_amount                   INTEGER NOT NULL CHECK (typeof(total_amount)='integer'    AND total_amount    >= 0),
        tax_mode                       TEXT NOT NULL CHECK (tax_mode IN ('none','inclusive','exclusive')),

        created_at                     TEXT NOT NULL,
        UNIQUE (refund_local_uuid, line_index),
        CHECK (tax_amount <= total_amount)
      ) STRICT;
      CREATE INDEX idx_local_refund_items_refund ON local_refund_items(refund_local_uuid, line_index);

      CREATE TABLE local_refund_payments (
        local_uuid              TEXT PRIMARY KEY,
        refund_local_uuid       TEXT NOT NULL REFERENCES local_refunds(local_uuid),
        payment_index            INTEGER NOT NULL CHECK (typeof(payment_index)='integer' AND payment_index >= 0),

        payment_method_uuid      TEXT,
        type                      TEXT NOT NULL CHECK (type IN ('cash','card','other')),
        amount                    INTEGER NOT NULL CHECK (typeof(amount)='integer' AND amount BETWEEN 0 AND 900000000000000),
        reference                 TEXT CHECK (reference IS NULL OR (length(reference) BETWEEN 1 AND 255 AND trim(reference) = reference)),

        created_at                 TEXT NOT NULL,
        UNIQUE (refund_local_uuid, payment_index)
      ) STRICT;
      CREATE INDEX idx_local_refund_payments_refund ON local_refund_payments(refund_local_uuid, payment_index);
    `)
  }
}
