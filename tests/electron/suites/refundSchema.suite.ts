import { equal, ok, throws } from 'node:assert/strict'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'

/**
 * Plan §3a/§7 (r5) — schema and durable-invariant coverage for `local_refunds`,
 * `local_refund_items` and `local_refund_payments`: CHECK constraints reject an inconsistent row,
 * and the partial unique index rejects a second OPEN refund on the same invoice — including when
 * the existing row is `conflict`.
 */

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'
const UUID_C = '00000000-0000-4000-8000-000000000003'
const HASH_64 = 'a'.repeat(64)
const NOW = '2026-09-22T12:00:00.000Z'

function insertAttempt(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    attempt_key: UUID_A,
    company_uuid: UUID_A,
    device_uuid: UUID_A,
    user_uuid: UUID_A,
    claim_session_epoch: 1,
    origin_shift_uuid: UUID_A,
    origin_shift_observed_at: NOW,
    origin_branch_uuid: UUID_A,
    origin_warehouse_uuid: UUID_A,
    origin_context_fingerprint: HASH_64,
    intent_fingerprint: HASH_64,
    intent_version: 1,
    intent_json: '{"v":1}',
    state: 'claimed',
    invoice_local_uuid: null,
    failure_code: null,
    claimed_at: NOW,
    last_attempted_at: null,
    committed_at: null,
    rejected_at: null,
    acknowledged_at: null,
    abandoned_at: null,
    updated_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO sale_attempts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertInvoice(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    local_uuid: UUID_A,
    attempt_key: UUID_A,
    offline_number: 'POS-000001-20260922-000001',
    remote_uuid: UUID_A,
    server_number: 'INV-0001',
    sync_status: 'synced',
    sync_attempts: 1,
    last_sync_error: null,
    synced_at: NOW,
    company_uuid: UUID_A,
    branch_uuid: UUID_A,
    warehouse_uuid: UUID_A,
    device_uuid: UUID_A,
    user_uuid: UUID_A,
    shift_uuid: UUID_A,
    commit_session_epoch: 1,
    catalog_revision: HASH_64,
    intent_fingerprint: HASH_64,
    customer_uuid: null,
    currency: 'USD',
    currency_exponent: 2,
    tax_mode: 'none',
    invoice_discount_type: null,
    invoice_discount_value: 0,
    subtotal_amount: 1000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 1000,
    paid_total_amount: 1000,
    change_due_amount: 0,
    due_amount: 0,
    sold_at: NOW,
    connectivity_state_at_sale: 'online',
    sold_while_offline: 0,
    notes: null,
    commercial_snapshot_json: '{}',
    upload_payload_version: 2,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_invoices (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertRefund(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    local_uuid: UUID_A,
    invoice_local_uuid: UUID_A,
    invoice_remote_uuid: UUID_A,
    company_uuid: UUID_A,
    device_uuid: UUID_A,
    user_uuid: UUID_A,
    shift_uuid: UUID_A,
    currency: 'USD',
    currency_exponent: 2,
    subtotal_amount: 1000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 1000,
    refunded_at: NOW,
    stock_returned: 1,
    reason: null,
    notes: null,
    request_json: '{}',
    request_sha256: HASH_64,
    preview_id: UUID_A,
    dispatch_count: 0,
    submission_state: 'prepared',
    remote_uuid: null,
    refund_number: null,
    cancelled_at: null,
    cancelled_reason: null,
    last_error_code: null,
    last_error_details: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_refunds (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

databaseTest('migration 0014 applies and creates the refund tables', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_refunds','local_refund_items','local_refund_payments')`
    )
    .all() as { name: string }[]
  equal(tables.length, 3)
  closeDatabase(database)
})

databaseTest('a prepared refund with dispatch_count > 0 is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() => insertRefund(database, { submission_state: 'prepared', dispatch_count: 1 }))
  closeDatabase(database)
})

databaseTest('a cancelled refund with dispatch_count > 0 is rejected (F3.2)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() =>
    insertRefund(database, {
      submission_state: 'cancelled',
      dispatch_count: 1,
      cancelled_at: NOW
    })
  )
  closeDatabase(database)
})

databaseTest('cancelled without cancelled_at is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() =>
    insertRefund(database, { submission_state: 'cancelled', dispatch_count: 0, cancelled_at: null })
  )
  closeDatabase(database)
})

databaseTest('accepted without a remote_uuid is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() =>
    insertRefund(database, { submission_state: 'accepted', dispatch_count: 1, remote_uuid: null })
  )
  closeDatabase(database)
})

databaseTest('accepted with a remote_uuid is accepted', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database, {
    submission_state: 'accepted',
    dispatch_count: 1,
    remote_uuid: UUID_B,
    refund_number: 'REF-0001'
  })
  const row = database.prepare(`SELECT submission_state FROM local_refunds`).get() as {
    submission_state: string
  }
  equal(row.submission_state, 'accepted')
  closeDatabase(database)
})

databaseTest('dispatched with dispatch_count = 0 is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() => insertRefund(database, { submission_state: 'dispatched', dispatch_count: 0 }))
  closeDatabase(database)
})

databaseTest(
  'the partial unique index rejects a second OPEN refund on the same invoice',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database, {
      local_uuid: UUID_A,
      submission_state: 'prepared',
      dispatch_count: 0
    })
    throws(() =>
      insertRefund(database, {
        local_uuid: UUID_B,
        submission_state: 'prepared',
        dispatch_count: 0
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a CONFLICT refund still blocks a replacement -- conflict stays inside the hold',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database, {
      local_uuid: UUID_A,
      submission_state: 'conflict',
      dispatch_count: 1
    })
    throws(() =>
      insertRefund(database, {
        local_uuid: UUID_B,
        submission_state: 'prepared',
        dispatch_count: 0
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a CANCELLED or REJECTED refund does not block a fresh refund on the same invoice',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database, {
      local_uuid: UUID_A,
      submission_state: 'cancelled',
      dispatch_count: 0,
      cancelled_at: NOW
    })
    insertRefund(database, {
      local_uuid: UUID_B,
      submission_state: 'rejected',
      dispatch_count: 1,
      last_error_code: 'refund_calculation_stale'
    })
    // A third, OPEN refund on the same invoice must still succeed -- neither prior row blocks it.
    insertRefund(database, {
      local_uuid: UUID_C,
      submission_state: 'prepared',
      dispatch_count: 0
    })
    const count = (
      database.prepare(`SELECT COUNT(*) as c FROM local_refunds`).get() as { c: number }
    ).c
    equal(count, 3)
    closeDatabase(database)
  }
)

databaseTest('a refund item with tax exceeding total is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database)
  throws(() =>
    database
      .prepare(
        `INSERT INTO local_refund_items
          (local_uuid, refund_local_uuid, line_index, invoice_item_remote_uuid, product_uuid,
           product_name, quantity_milli, prior_refunded_quantity_milli,
           subtotal_amount, discount_amount, tax_amount, total_amount, tax_mode, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        UUID_A,
        UUID_A,
        0,
        UUID_A,
        UUID_A,
        'Product',
        1000,
        0,
        100,
        0,
        200,
        100,
        'exclusive',
        NOW
      )
  )
  closeDatabase(database)
})

databaseTest('a refund item with a non-integer amount is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database)
  throws(() =>
    database
      .prepare(
        `INSERT INTO local_refund_items
          (local_uuid, refund_local_uuid, line_index, invoice_item_remote_uuid, product_uuid,
           product_name, quantity_milli, prior_refunded_quantity_milli,
           subtotal_amount, discount_amount, tax_amount, total_amount, tax_mode, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        UUID_A,
        UUID_A,
        0,
        UUID_A,
        UUID_A,
        'Product',
        1000,
        0,
        100.5,
        0,
        0,
        100,
        'exclusive',
        NOW
      )
  )
  closeDatabase(database)
})

databaseTest('a refund payment of an unsupported type is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database)
  throws(() =>
    database
      .prepare(
        `INSERT INTO local_refund_payments
          (local_uuid, refund_local_uuid, payment_index, payment_method_uuid, type, amount, reference, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(UUID_A, UUID_A, 0, UUID_A, 'wallet', 1000, null, NOW)
  )
  closeDatabase(database)
})

databaseTest('a valid refund with items and a payment persists atomically', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database, { submission_state: 'prepared', dispatch_count: 0 })
  database
    .prepare(
      `INSERT INTO local_refund_items
        (local_uuid, refund_local_uuid, line_index, invoice_item_remote_uuid, product_uuid,
         product_name, quantity_milli, prior_refunded_quantity_milli,
         subtotal_amount, discount_amount, tax_amount, total_amount, tax_mode, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(UUID_A, UUID_A, 0, UUID_A, UUID_A, 'Product', 1000, 0, 1000, 0, 0, 1000, 'exclusive', NOW)
  database
    .prepare(
      `INSERT INTO local_refund_payments
        (local_uuid, refund_local_uuid, payment_index, payment_method_uuid, type, amount, reference, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(UUID_A, UUID_A, 0, UUID_A, 'cash', 1000, null, NOW)

  const items = database.prepare(`SELECT COUNT(*) c FROM local_refund_items`).get() as { c: number }
  const payments = database.prepare(`SELECT COUNT(*) c FROM local_refund_payments`).get() as {
    c: number
  }
  equal(items.c, 1)
  equal(payments.c, 1)
  closeDatabase(database)
})

databaseTest('an invalid currency code is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  throws(() => insertRefund(database, { currency: 'usd' }))
  closeDatabase(database)
})

databaseTest(
  'a zero grand_total_amount is rejected (D4: zero-value refunds are refused)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    throws(() => insertRefund(database, { grand_total_amount: 0 }))
    closeDatabase(database)
  }
)

ok(true, 'refundSchema.suite loaded')
