import { equal, throws } from 'node:assert/strict'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'

/**
 * Receipt-printing plan §D-8/§D-11 — the enforceable composite-FK identity invariants for receipt
 * context, and the print-job/profile-mirror schema invariants (migration 0015).
 */

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'
const UUID_C = '00000000-0000-4000-8000-000000000003'
const HASH_64 = 'a'.repeat(64)
const NOW = '2026-09-23T12:00:00.000Z'

function row(
  overrides: Record<string, unknown>,
  base: Record<string, unknown>
): Record<string, unknown> {
  return { ...base, ...overrides }
}

function insertRow(database: SqliteDatabase, table: string, values: Record<string, unknown>): void {
  const columns = Object.keys(values)
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((c) => values[c]))
}

function insertAttempt(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  insertRow(
    database,
    'sale_attempts',
    row(overrides, {
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
      updated_at: NOW
    })
  )
}

function insertInvoice(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  insertRow(
    database,
    'local_invoices',
    row(overrides, {
      local_uuid: UUID_A,
      attempt_key: UUID_A,
      offline_number: 'POS-000001-20260923-000001',
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
      updated_at: NOW
    })
  )
}

function insertRefund(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  insertRow(
    database,
    'local_refunds',
    row(overrides, {
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
      dispatch_count: 1,
      submission_state: 'accepted',
      remote_uuid: UUID_A,
      refund_number: 'REF-0001',
      cancelled_at: null,
      cancelled_reason: null,
      last_error_code: null,
      last_error_details: null,
      created_at: NOW,
      updated_at: NOW
    })
  )
}

function insertRefundItem(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  insertRow(
    database,
    'local_refund_items',
    row(overrides, {
      local_uuid: UUID_A,
      refund_local_uuid: UUID_A,
      line_index: 0,
      invoice_item_remote_uuid: UUID_A,
      product_uuid: UUID_A,
      product_name: 'Widget',
      quantity_milli: 1000,
      prior_refunded_quantity_milli: 0,
      subtotal_amount: 1000,
      discount_amount: 0,
      tax_amount: 0,
      total_amount: 1000,
      tax_mode: 'none',
      created_at: NOW
    })
  )
}

function insertInvoiceContext(
  database: SqliteDatabase,
  overrides: Record<string, unknown> = {}
): void {
  insertRow(
    database,
    'local_invoice_receipt_context',
    row(overrides, {
      invoice_local_uuid: UUID_A,
      company_uuid: UUID_A,
      context_version: 1,
      issuer_company_name: 'Acme',
      issuer_branch_name: 'Main',
      issuer_warehouse_name: 'WH1',
      cashier_display_name: 'Cashier',
      customer_name: null,
      customer_tax_number: null,
      time_zone: 'Africa/Cairo',
      receipt_profile_version_uuid: null,
      created_at: NOW
    })
  )
}

function insertRefundContext(
  database: SqliteDatabase,
  overrides: Record<string, unknown> = {}
): void {
  insertRow(
    database,
    'local_refund_receipt_context',
    row(overrides, {
      refund_local_uuid: UUID_A,
      company_uuid: UUID_A,
      context_version: 1,
      issuer_company_name: 'Acme',
      issuer_branch_name: 'Main',
      cashier_display_name: 'Cashier',
      payment_method_name: 'Cash',
      original_offline_number: 'POS-000001-20260923-000001',
      original_server_number: 'INV-0001',
      time_zone: 'Africa/Cairo',
      receipt_profile_version_uuid: null,
      created_at: NOW
    })
  )
}

// -------------------------------------------------------------------------------------------
// Tables exist
// -------------------------------------------------------------------------------------------

databaseTest('migration 0015 creates every receipt-printing table', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const expected = [
    'receipt_profile_assets',
    'receipt_profile_versions',
    'receipt_profile_current',
    'receipt_profile_authority',
    'local_invoice_receipt_context',
    'local_refund_receipt_context',
    'local_refund_line_receipt_context',
    'receipt_print_jobs'
  ]
  const tables = (
    database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expected.map(() => '?').join(',')})`
      )
      .all(...expected) as { name: string }[]
  ).map((r) => r.name)
  equal(tables.length, expected.length)
  closeDatabase(database)
})

// -------------------------------------------------------------------------------------------
// D-8: sale/refund context composite-FK identity
// -------------------------------------------------------------------------------------------

databaseTest('a correct sale context insert succeeds', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertInvoiceContext(database)
  const found = database
    .prepare(
      'SELECT issuer_company_name FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?'
    )
    .get(UUID_A) as { issuer_company_name: string }
  equal(found.issuer_company_name, 'Acme')
  closeDatabase(database)
})

databaseTest(
  'a sale context row referencing a mismatched company_uuid is rejected by the FK',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    throws(() => insertInvoiceContext(database, { company_uuid: UUID_B }))
    closeDatabase(database)
  }
)

databaseTest('a correct refund + line context insert succeeds', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database)
  insertRefundItem(database)
  insertRefundContext(database)
  insertRow(database, 'local_refund_line_receipt_context', {
    refund_item_local_uuid: UUID_A,
    refund_local_uuid: UUID_A,
    invoice_item_remote_uuid: UUID_A,
    original_unit_price_amount: 1000,
    original_quantity_milli: 1000,
    unit: 'pc',
    sku: 'SKU-1',
    tax_rate_text: null,
    created_at: NOW
  })
  const found = database
    .prepare('SELECT sku FROM local_refund_line_receipt_context WHERE refund_item_local_uuid = ?')
    .get(UUID_A) as { sku: string }
  equal(found.sku, 'SKU-1')
  closeDatabase(database)
})

databaseTest('a line context referencing a missing parent item fails', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertRefund(database)
  insertRefundContext(database)
  // No local_refund_items row exists at all for UUID_A.
  throws(() =>
    insertRow(database, 'local_refund_line_receipt_context', {
      refund_item_local_uuid: UUID_A,
      refund_local_uuid: UUID_A,
      invoice_item_remote_uuid: UUID_A,
      original_unit_price_amount: null,
      original_quantity_milli: null,
      unit: null,
      sku: null,
      tax_rate_text: null,
      created_at: NOW
    })
  )
  closeDatabase(database)
})

databaseTest(
  'a line context referencing an item that belongs to ANOTHER refund fails',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database, { local_uuid: UUID_A })
    // remote_uuid is UNIQUE on local_refunds, so the second refund needs its own.
    insertRefund(database, { local_uuid: UUID_B, invoice_local_uuid: UUID_A, remote_uuid: UUID_B })
    insertRefundItem(database, { local_uuid: UUID_A, refund_local_uuid: UUID_A })
    insertRefundContext(database, { refund_local_uuid: UUID_B })

    throws(() =>
      insertRow(database, 'local_refund_line_receipt_context', {
        refund_item_local_uuid: UUID_A, // this item's local uuid belongs to refund A...
        refund_local_uuid: UUID_B, // ...but this context claims it is refund B's line
        invoice_item_remote_uuid: UUID_A,
        original_unit_price_amount: null,
        original_quantity_milli: null,
        unit: null,
        sku: null,
        tax_rate_text: null,
        created_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a line context asserting the WRONG original server item uuid fails, even for the same refund item',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database)
    insertRefundItem(database, { invoice_item_remote_uuid: UUID_A })
    insertRefundContext(database)

    throws(() =>
      insertRow(database, 'local_refund_line_receipt_context', {
        refund_item_local_uuid: UUID_A,
        refund_local_uuid: UUID_A,
        invoice_item_remote_uuid: UUID_B, // wrong -- the real item's remote uuid is UUID_A
        original_unit_price_amount: null,
        original_quantity_milli: null,
        unit: null,
        sku: null,
        tax_rate_text: null,
        created_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'the same product on two distinct original invoice lines cannot be cross-associated',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database)
    // Two refund items for the SAME product, but two DIFFERENT original server items.
    insertRefundItem(database, {
      local_uuid: UUID_A,
      line_index: 0,
      invoice_item_remote_uuid: UUID_B,
      product_uuid: UUID_C
    })
    insertRefundItem(database, {
      local_uuid: UUID_B,
      line_index: 1,
      invoice_item_remote_uuid: UUID_C,
      product_uuid: UUID_C
    })
    insertRefundContext(database)

    // Correct: item A's context must cite item B's remote uuid.
    insertRow(database, 'local_refund_line_receipt_context', {
      refund_item_local_uuid: UUID_A,
      refund_local_uuid: UUID_A,
      invoice_item_remote_uuid: UUID_B,
      original_unit_price_amount: null,
      original_quantity_milli: null,
      unit: null,
      sku: null,
      tax_rate_text: null,
      created_at: NOW
    })

    // Wrong: item A's context cannot cite item B's OWN server item uuid (UUID_C) instead of its own.
    throws(() =>
      insertRow(database, 'local_refund_line_receipt_context', {
        refund_item_local_uuid: UUID_A,
        refund_local_uuid: UUID_A,
        invoice_item_remote_uuid: UUID_C,
        original_unit_price_amount: null,
        original_quantity_milli: null,
        unit: null,
        sku: null,
        tax_rate_text: null,
        created_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'a duplicate context row for the same refund item is rejected (primary key)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertRefund(database)
    insertRefundItem(database)
    insertRefundContext(database)
    insertRow(database, 'local_refund_line_receipt_context', {
      refund_item_local_uuid: UUID_A,
      refund_local_uuid: UUID_A,
      invoice_item_remote_uuid: UUID_A,
      original_unit_price_amount: null,
      original_quantity_milli: null,
      unit: null,
      sku: null,
      tax_rate_text: null,
      created_at: NOW
    })
    throws(() =>
      insertRow(database, 'local_refund_line_receipt_context', {
        refund_item_local_uuid: UUID_A,
        refund_local_uuid: UUID_A,
        invoice_item_remote_uuid: UUID_A,
        original_unit_price_amount: null,
        original_quantity_milli: null,
        unit: null,
        sku: null,
        tax_rate_text: null,
        created_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest('context rows cannot be updated or deleted (immutability triggers)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertInvoiceContext(database)
  throws(() =>
    database
      .prepare(
        'UPDATE local_invoice_receipt_context SET issuer_company_name = ? WHERE invoice_local_uuid = ?'
      )
      .run('Changed', UUID_A)
  )
  throws(() =>
    database
      .prepare('DELETE FROM local_invoice_receipt_context WHERE invoice_local_uuid = ?')
      .run(UUID_A)
  )
  closeDatabase(database)
})

databaseTest('a rolled-back business transaction leaves no orphan context row', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)

  throws(() =>
    database.transaction(() => {
      insertInvoiceContext(database)
      // Force a rollback: a second, invalid write inside the SAME transaction.
      database
        .prepare('INSERT INTO local_invoice_receipt_context (invoice_local_uuid) VALUES (?)')
        .run(UUID_A)
    })()
  )

  const count = database
    .prepare('SELECT COUNT(*) AS total FROM local_invoice_receipt_context')
    .get() as { total: number }
  equal(count.total, 0)
  closeDatabase(database)
})

// -------------------------------------------------------------------------------------------
// Receipt profile mirror
// -------------------------------------------------------------------------------------------

databaseTest('a profile asset moves from pending to available exactly once', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertRow(database, 'receipt_profile_assets', {
    company_uuid: UUID_A,
    sha256: HASH_64,
    media_type: 'image/png',
    width_px: 64,
    height_px: 32,
    byte_length: 100,
    content: null,
    status: 'pending',
    created_at: NOW,
    fetched_at: null
  })

  database
    .prepare(
      `UPDATE receipt_profile_assets SET status='available', content=?, fetched_at=? WHERE company_uuid=? AND sha256=?`
    )
    .run(Buffer.from('x'), NOW, UUID_A, HASH_64)

  throws(() =>
    database
      .prepare(`UPDATE receipt_profile_assets SET content=? WHERE company_uuid=? AND sha256=?`)
      .run(Buffer.from('y'), UUID_A, HASH_64)
  )
  closeDatabase(database)
})

databaseTest('a profile version is insert-only', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertRow(database, 'receipt_profile_versions', {
    version_uuid: UUID_A,
    company_uuid: UUID_A,
    revision: 1,
    fields_json: '{}',
    fields_sha256: HASH_64,
    logo_sha256: null,
    received_at: NOW
  })
  throws(() =>
    database
      .prepare('UPDATE receipt_profile_versions SET revision = 2 WHERE version_uuid = ?')
      .run(UUID_A)
  )
  throws(() =>
    database.prepare('DELETE FROM receipt_profile_versions WHERE version_uuid = ?').run(UUID_A)
  )
  closeDatabase(database)
})

// -------------------------------------------------------------------------------------------
// Print-job journal
// -------------------------------------------------------------------------------------------

function insertJob(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  insertRow(
    database,
    'receipt_print_jobs',
    row(overrides, {
      job_uuid: UUID_A,
      request_id: UUID_A,
      client_intent_json: '{}',
      client_intent_sha256: HASH_64,
      trigger: 'manual',
      owner_company_uuid: UUID_A,
      owner_device_uuid: UUID_A,
      requested_by_user_uuid: UUID_A,
      session_epoch_at_claim: 1,
      document_kind: 'sale',
      document_local_uuid: UUID_A,
      document_json: '{}',
      document_sha256: HASH_64,
      template_version: 1,
      locale: 'en',
      is_reprint: 0,
      facts_projection: 'sale-facts/1',
      transaction_facts_sha256: HASH_64,
      resolved_options_json: '{}',
      options_sha256: HASH_64,
      layout_json: null,
      layout_sha256: null,
      status: 'queued',
      cancel_origin: null,
      worker_lease_id: null,
      dispatch_token: null,
      failure_code: null,
      os_callback_at: null,
      os_callback_success: null,
      os_callback_reason: null,
      created_at: NOW,
      preparing_at: null,
      dispatched_at: null,
      unknown_at: null,
      finished_at: null,
      window_released_at: null
    })
  )
}

databaseTest(
  'a job cannot be inserted as a test document with a non-null transaction facts hash',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    throws(() => insertJob(database, { document_kind: 'test', document_local_uuid: 'test' }))
    closeDatabase(database)
  }
)

databaseTest('the status transition guard allows queued -> preparing', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertJob(database)
  database
    .prepare(`UPDATE receipt_print_jobs SET status='preparing', worker_lease_id=? WHERE job_uuid=?`)
    .run(UUID_A, UUID_A)
  const found = database
    .prepare('SELECT status FROM receipt_print_jobs WHERE job_uuid=?')
    .get(UUID_A) as {
    status: string
  }
  equal(found.status, 'preparing')
  closeDatabase(database)
})

databaseTest(
  'the status transition guard rejects queued -> submitted directly (skipping preparing/dispatching)',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertJob(database)
    throws(() =>
      database
        .prepare(`UPDATE receipt_print_jobs SET status='submitted' WHERE job_uuid=?`)
        .run(UUID_A)
    )
    closeDatabase(database)
  }
)

databaseTest(
  'the status transition guard rejects a regression from submitted back to any other status',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertJob(database, {
      status: 'dispatching',
      worker_lease_id: UUID_A,
      dispatch_token: UUID_A,
      dispatched_at: NOW,
      layout_json: '{}'
    })
    database
      .prepare(`UPDATE receipt_print_jobs SET status='submitted', finished_at=? WHERE job_uuid=?`)
      .run(NOW, UUID_A)
    throws(() =>
      database
        .prepare(`UPDATE receipt_print_jobs SET status='outcome_unknown' WHERE job_uuid=?`)
        .run(UUID_A)
    )
    closeDatabase(database)
  }
)

databaseTest(
  'the status transition guard allows outcome_unknown -> submitted (late success) only',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertJob(database, {
      status: 'outcome_unknown',
      worker_lease_id: UUID_A,
      dispatch_token: UUID_A,
      dispatched_at: NOW,
      layout_json: '{}'
    })
    database
      .prepare(`UPDATE receipt_print_jobs SET status='submitted', finished_at=? WHERE job_uuid=?`)
      .run(NOW, UUID_A)
    const found = database
      .prepare('SELECT status FROM receipt_print_jobs WHERE job_uuid=?')
      .get(UUID_A) as {
      status: string
    }
    equal(found.status, 'submitted')
    closeDatabase(database)
  }
)

databaseTest('receipt_print_jobs rows are never deleted', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertJob(database)
  throws(() => database.prepare('DELETE FROM receipt_print_jobs WHERE job_uuid=?').run(UUID_A))
  closeDatabase(database)
})

databaseTest('the reservation index allows only one non-terminal job per document', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertJob(database, { job_uuid: UUID_A, request_id: UUID_A, status: 'queued' })
  throws(() => insertJob(database, { job_uuid: UUID_B, request_id: UUID_B, status: 'queued' }))
  closeDatabase(database)
})

databaseTest('a terminal job does not block a new job for the same document', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertJob(database, {
    job_uuid: UUID_A,
    request_id: UUID_A,
    status: 'submitted',
    worker_lease_id: UUID_A,
    dispatch_token: UUID_A,
    dispatched_at: NOW,
    layout_json: '{}',
    finished_at: NOW
  })
  insertJob(database, { job_uuid: UUID_B, request_id: UUID_B, status: 'queued' })
  const count = database.prepare('SELECT COUNT(*) AS total FROM receipt_print_jobs').get() as {
    total: number
  }
  equal(count.total, 2)
  closeDatabase(database)
})

databaseTest('the auto-print index allows only one AUTO job ever per document', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertJob(database, {
    job_uuid: UUID_A,
    request_id: UUID_A,
    trigger: 'auto',
    status: 'submitted',
    worker_lease_id: UUID_A,
    dispatch_token: UUID_A,
    dispatched_at: NOW,
    layout_json: '{}',
    finished_at: NOW
  })
  throws(() => insertJob(database, { job_uuid: UUID_B, request_id: UUID_B, trigger: 'auto' }))
  closeDatabase(database)
})
