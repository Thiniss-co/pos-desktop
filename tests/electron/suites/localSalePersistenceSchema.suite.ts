import { ok, throws } from 'node:assert/strict'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import {
  applyAllTestMigrations,
  openPreLocalSalePersistenceTestDatabase,
  openTestDatabase
} from '../support/openTestDatabase'

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'
const HASH_64 = 'a'.repeat(64)
const NOW = '2026-08-29T12:00:00.000Z'

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
    offline_number: 'POS-000001-20260829-000001',
    remote_uuid: null,
    server_number: null,
    sync_status: 'pending',
    sync_attempts: 0,
    last_sync_error: null,
    synced_at: null,
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

function insertItem(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    local_uuid: UUID_A,
    invoice_local_uuid: UUID_A,
    line_index: 0,
    product_uuid: UUID_A,
    product_name: 'Widget',
    sku: null,
    barcode: null,
    unit: null,
    track_stock: 1,
    quantity_milli: 1000,
    unit_price_amount: 1000,
    currency: 'USD',
    price_revision: HASH_64,
    tax_uuid: null,
    tax_mode: 'none',
    tax_rate_basis_points: 0,
    tax_revision: HASH_64,
    discount_type: null,
    discount_value: 0,
    subtotal_amount: 1000,
    discount_amount: 0,
    tax_amount: 0,
    total_amount: 1000,
    created_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_invoice_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertPayment(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    local_uuid: UUID_A,
    invoice_local_uuid: UUID_A,
    payment_index: 0,
    payment_method_uuid: UUID_A,
    type: 'cash',
    amount: 1000,
    reference: null,
    requires_reference: 0,
    paid_at: NOW,
    method_snapshot_json: '{}',
    created_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_invoice_payments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertGrant(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    allocation_uuid: UUID_A,
    contract_version: 1,
    company_uuid: UUID_A,
    device_uuid: UUID_A,
    warehouse_uuid: UUID_A,
    product_uuid: UUID_A,
    server_sequence: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 5000,
    consume_until: NOW,
    status: 'active',
    envelope_hash: HASH_64,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    received_at: NOW,
    sealed_at: null,
    finalized_at: null,
    updated_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO stock_allocation_grants (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertConsumption(
  database: SqliteDatabase,
  overrides: Record<string, unknown> = {}
): void {
  const row = {
    local_uuid: UUID_A,
    allocation_uuid: UUID_A,
    consumption_sequence: 1,
    invoice_local_uuid: UUID_A,
    item_local_uuid: UUID_A,
    quantity_milli: 1000,
    server_status: 'pending',
    server_consumption_uuid: null,
    acknowledged_at: null,
    created_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_stock_allocation_consumptions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

function insertMovement(database: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  const row = {
    local_uuid: UUID_A,
    invoice_local_uuid: UUID_A,
    item_local_uuid: UUID_A,
    product_uuid: UUID_A,
    warehouse_uuid: UUID_A,
    direction: 'out',
    quantity_milli: 1000,
    sync_status: 'pending',
    synced_at: null,
    created_at: NOW,
    ...overrides
  }
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO local_stock_movements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column as keyof typeof row]))
}

// Mirrors the real transaction sequence (plan §"Transaction sequence", step 17): claim first, then
// insert the invoice (which references the still-claimed attempt), then flip the attempt to
// committed and attach the invoice — never the other way around, since sale_attempts.invoice_local_uuid
// and local_invoices.attempt_key are a genuine circular foreign-key pair.
function commitAttempt(
  database: SqliteDatabase,
  attemptKey: string,
  invoiceLocalUuid: string
): void {
  database
    .prepare(
      `UPDATE sale_attempts
         SET state = 'committed', invoice_local_uuid = ?, committed_at = ?, last_attempted_at = ?, updated_at = ?
       WHERE attempt_key = ?`
    )
    .run(invoiceLocalUuid, NOW, NOW, NOW, attemptKey)
}

databaseTest('fresh install applies migration 0007 with every Phase 3F table', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const tables = (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)

  for (const table of [
    'sale_attempts',
    'local_invoices',
    'local_invoice_items',
    'local_invoice_payments',
    'stock_allocation_grants',
    'local_stock_allocation_consumptions',
    'local_stock_movements'
  ]) {
    ok(tables.includes(table), `missing table ${table}`)
  }

  for (const table of [
    'sale_attempts',
    'local_invoices',
    'local_invoice_items',
    'local_invoice_payments',
    'stock_allocation_grants',
    'local_stock_allocation_consumptions',
    'local_stock_movements'
  ]) {
    const definition = (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string }
    ).sql
    ok(definition.includes(' STRICT'), `${table} must be STRICT`)
  }

  closeDatabase(database)
})

databaseTest(
  'an existing version-6 database migrates additively to 0007 with its state intact',
  (sandbox) => {
    const database = openPreLocalSalePersistenceTestDatabase(sandbox)
    applyAllTestMigrations(database)

    const epoch = database.prepare('SELECT value FROM session_epoch WHERE id = 1').get() as {
      value: number
    }
    ok(epoch.value === 1, 'pre-existing state must survive the additive migration')

    const versions = (
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number
      }>
    ).map((row) => row.version)
    ok(versions.includes(7), 'migration 0007 must have applied')

    closeDatabase(database)
  }
)

databaseTest('every STRICT integer column rejects a fractional value', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)

  throws(() => insertInvoice(database, { commit_session_epoch: 1.5 }))
  throws(() => insertGrant(database, { granted_quantity_milli: 1.5 }))

  closeDatabase(database)
})

databaseTest('local_stock_movements can never be created with sync_status=synced', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertItem(database)

  throws(() => insertMovement(database, { sync_status: 'synced' }))
  closeDatabase(database)
})

databaseTest('local_stock_movements can never carry a non-null synced_at', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertItem(database)

  throws(() => insertMovement(database, { synced_at: NOW }))
  closeDatabase(database)
})

databaseTest('local_invoices cannot be marked synced with a NULL synced_at', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)

  throws(() => insertInvoice(database, { sync_status: 'synced', synced_at: null }))
  closeDatabase(database)
})

databaseTest('a fixed line discount cannot exceed its own subtotal', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)

  throws(() =>
    insertItem(database, { discount_type: 'fixed', discount_value: 1001, subtotal_amount: 1000 })
  )
  closeDatabase(database)
})

databaseTest('a percentage discount above 10000 basis points is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)

  throws(() => insertItem(database, { discount_type: 'percentage', discount_value: 10001 }))
  closeDatabase(database)
})

databaseTest('an untrimmed payment reference is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)

  throws(() => insertPayment(database, { reference: ' padded ' }))
  closeDatabase(database)
})

databaseTest('requires_reference=1 with a blank reference is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)

  throws(() => insertPayment(database, { requires_reference: 1, reference: null }))
  closeDatabase(database)
})

databaseTest('at most one stock movement can exist per invoice item', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertItem(database)
  insertMovement(database)

  throws(() => insertMovement(database, { local_uuid: UUID_B }))
  closeDatabase(database)
})

databaseTest(
  'the partial unique index allows only one invoice/upload row in sync_queue',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const insertQueue = (localQueueUuid: string): void => {
      database
        .prepare(
          `INSERT INTO sync_queue (
             local_queue_uuid, aggregate_type, local_aggregate_uuid, operation, payload_json,
             payload_hash, idempotency_key, state, created_at, updated_at
           ) VALUES (?, 'invoice', ?, 'upload', '{}', ?, ?, 'pending', ?, ?)`
        )
        .run(localQueueUuid, UUID_A, HASH_64, localQueueUuid, NOW, NOW)
    }
    insertQueue(UUID_A)

    throws(() => insertQueue(UUID_B))
    closeDatabase(database)
  }
)

databaseTest('at most one claimed attempt exists per (company, device, cashier)', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database, { attempt_key: UUID_A })

  throws(() => insertAttempt(database, { attempt_key: UUID_B }))
  closeDatabase(database)
})

databaseTest(
  'two committed-unacknowledged attempts plus one claimed attempt are valid for one owner',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const committedA = '00000000-0000-4000-8000-000000000010'
    const committedB = '00000000-0000-4000-8000-000000000011'
    const claimed = '00000000-0000-4000-8000-000000000012'
    const invoiceA = '00000000-0000-4000-8000-000000000013'
    const invoiceB = '00000000-0000-4000-8000-000000000014'

    insertAttempt(database, { attempt_key: committedA })
    insertInvoice(database, {
      local_uuid: invoiceA,
      attempt_key: committedA,
      offline_number: 'POS-000001-20260829-000010'
    })
    commitAttempt(database, committedA, invoiceA)

    insertAttempt(database, { attempt_key: committedB })
    insertInvoice(database, {
      local_uuid: invoiceB,
      attempt_key: committedB,
      offline_number: 'POS-000001-20260829-000011'
    })
    commitAttempt(database, committedB, invoiceB)

    insertAttempt(database, { attempt_key: claimed })

    const claimedCount = (
      database
        .prepare("SELECT COUNT(*) AS total FROM sale_attempts WHERE state = 'claimed'")
        .get() as { total: number }
    ).total
    ok(claimedCount === 1)
    closeDatabase(database)
  }
)

databaseTest('a committed attempt must carry an invoice_local_uuid', (sandbox) => {
  const database = openTestDatabase(sandbox)
  throws(() =>
    insertAttempt(database, {
      state: 'committed',
      invoice_local_uuid: null,
      committed_at: NOW,
      last_attempted_at: NOW
    })
  )
  closeDatabase(database)
})

databaseTest('a claimed or committed attempt must retain intent_json', (sandbox) => {
  const database = openTestDatabase(sandbox)
  throws(() => insertAttempt(database, { state: 'claimed', intent_json: null }))
  closeDatabase(database)
})

for (const terminalState of ['rejected', 'acknowledged', 'abandoned'] as const) {
  databaseTest(`a ${terminalState} attempt can never retain intent_json`, (sandbox) => {
    const database = openTestDatabase(sandbox)
    const overrides: Record<string, unknown> =
      terminalState === 'rejected'
        ? {
            state: 'rejected',
            intent_json: '{}',
            failure_code: 'invalid-request',
            rejected_at: NOW,
            last_attempted_at: NOW
          }
        : terminalState === 'acknowledged'
          ? {
              state: 'acknowledged',
              intent_json: '{}',
              invoice_local_uuid: UUID_A,
              committed_at: NOW,
              acknowledged_at: NOW,
              last_attempted_at: NOW
            }
          : { state: 'abandoned', intent_json: '{}', abandoned_at: NOW }

    if (terminalState === 'acknowledged') {
      throws(() => {
        insertAttempt(database, overrides)
      })
    } else {
      throws(() => insertAttempt(database, overrides))
    }
    closeDatabase(database)
  })
}

databaseTest('a rejected attempt must carry a failure_code', (sandbox) => {
  const database = openTestDatabase(sandbox)
  throws(() =>
    insertAttempt(database, {
      state: 'rejected',
      intent_json: null,
      failure_code: null,
      rejected_at: NOW,
      last_attempted_at: NOW
    })
  )
  closeDatabase(database)
})

databaseTest('intent_json accepts exactly 65536 UTF-8 bytes and rejects 65538', (sandbox) => {
  const database = openTestDatabase(sandbox)
  // Plan probe P7: 'é' is 2 UTF-8 bytes, so 32,768 repeats is exactly 65,536 bytes (accepted) and
  // 32,769 repeats is 65,538 bytes (rejected) — length() in the CHECK counts BLOB bytes, not
  // characters, so a naive character-count boundary would be silently wrong here.
  const within = 'é'.repeat(32_768)
  const over = 'é'.repeat(32_769)
  ok(Buffer.byteLength(within, 'utf8') === 65_536)
  ok(Buffer.byteLength(over, 'utf8') === 65_538)

  insertAttempt(database, { intent_json: within })
  throws(() => insertAttempt(database, { attempt_key: UUID_B, intent_json: over }))
  closeDatabase(database)
})

databaseTest('an invalid connectivity_state/sold_while_offline pairing is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)

  throws(() =>
    insertInvoice(database, { connectivity_state_at_sale: 'online', sold_while_offline: 1 })
  )
  throws(() =>
    insertInvoice(database, { connectivity_state_at_sale: 'offline', sold_while_offline: 0 })
  )
  closeDatabase(database)
})

databaseTest('a released allocation grant must carry its full finalization triple', (sandbox) => {
  const database = openTestDatabase(sandbox)
  throws(() => insertGrant(database, { status: 'released' }))
  insertGrant(database, {
    status: 'released',
    final_consumption_sequence: 3,
    final_consumption_hash: HASH_64,
    finalized_at: NOW,
    sealed_at: NOW
  })
  closeDatabase(database)
})

databaseTest('a non-active allocation status must carry a sealed_at timestamp', (sandbox) => {
  const database = openTestDatabase(sandbox)
  throws(() => insertGrant(database, { status: 'sealed', sealed_at: null }))
  closeDatabase(database)
})

databaseTest(
  'allocation consumption cannot reference a foreign-key-missing grant, invoice, or item',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertItem(database)

    throws(() => insertConsumption(database, { allocation_uuid: UUID_B }))
    closeDatabase(database)
  }
)

databaseTest('a duplicate per-grant consumption sequence is rejected', (sandbox) => {
  const database = openTestDatabase(sandbox)
  insertAttempt(database)
  insertInvoice(database)
  insertItem(database)
  insertGrant(database)
  insertConsumption(database)

  throws(() =>
    insertConsumption(database, {
      local_uuid: UUID_B,
      item_local_uuid: UUID_B,
      consumption_sequence: 1
    })
  )
  closeDatabase(database)
})

databaseTest(
  'an acknowledged consumption must carry both server identity and timestamp',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    insertAttempt(database)
    insertInvoice(database)
    insertItem(database)
    insertGrant(database)

    throws(() =>
      insertConsumption(database, {
        server_status: 'acknowledged',
        server_consumption_uuid: null,
        acknowledged_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest(
  'existing preview/shift suites see zero rows in every new business table',
  (sandbox) => {
    const database = openTestDatabase(sandbox)

    for (const table of [
      'local_invoices',
      'local_invoice_items',
      'local_invoice_payments',
      'local_stock_movements',
      'sale_attempts'
    ]) {
      const count = (
        database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
      ).total
      ok(count === 0, `${table} must start empty`)
    }
    const invoiceQueueCount = (
      database
        .prepare("SELECT COUNT(*) AS total FROM sync_queue WHERE aggregate_type = 'invoice'")
        .get() as { total: number }
    ).total
    ok(invoiceQueueCount === 0)
    closeDatabase(database)
  }
)
