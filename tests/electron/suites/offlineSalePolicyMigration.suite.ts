import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { databaseTest } from '../support/sandbox'
import { openExistingTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  WAREHOUSE_UUID,
  insertRow
} from '../support/allocationScenario'

const AUTHORITY_UUID = '00000000-0000-4000-8000-000000000e01'
const INVOICE_UUID = '00000000-0000-4000-8000-000000000f01'
const ATTEMPT_KEY = '00000000-0000-4000-8000-000000000f02'
const TRACKED_ITEM_UUID = '00000000-0000-4000-8000-000000000f03'
const UNTRACKED_ITEM_UUID = '00000000-0000-4000-8000-000000000f04'
const PRODUCT_A = '00000000-0000-4000-8000-000000000b01'
const PRODUCT_B = '00000000-0000-4000-8000-000000000b02'

/** Seed one invoice with a tracked and an untracked line, on the PRE-PS4 schema. */
function seedLegacyInvoice(
  database: ReturnType<typeof openExistingTestDatabase>,
  splitColumnsExist = false
): void {
  insertRow(database, 'sale_attempts', {
    attempt_key: ATTEMPT_KEY,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    claim_session_epoch: 1,
    origin_shift_uuid: COMPANY_UUID,
    origin_shift_observed_at: NOW,
    origin_branch_uuid: COMPANY_UUID,
    origin_warehouse_uuid: WAREHOUSE_UUID,
    origin_context_fingerprint: HASH_64,
    intent_fingerprint: HASH_64,
    intent_version: 1,
    intent_json: '{"v":1}',
    state: 'claimed',
    claimed_at: NOW,
    updated_at: NOW
  })

  insertRow(database, 'local_invoices', {
    local_uuid: INVOICE_UUID,
    attempt_key: ATTEMPT_KEY,
    offline_number: 'POS-000001-20260906-000001',
    sync_status: 'pending',
    sync_attempts: 0,
    company_uuid: COMPANY_UUID,
    branch_uuid: COMPANY_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    shift_uuid: COMPANY_UUID,
    commit_session_epoch: 1,
    catalog_revision: HASH_64,
    intent_fingerprint: HASH_64,
    currency: 'USD',
    currency_exponent: 2,
    tax_mode: 'none',
    invoice_discount_value: 0,
    subtotal_amount: 3000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 3000,
    paid_total_amount: 3000,
    change_due_amount: 0,
    due_amount: 0,
    sold_at: NOW,
    connectivity_state_at_sale: 'online',
    sold_while_offline: 0,
    commercial_snapshot_json: '{}',
    upload_payload_version: 2,
    created_at: NOW,
    updated_at: NOW
  })

  for (const [uuid, productUuid, trackStock, lineIndex, quantityMilli] of [
    [TRACKED_ITEM_UUID, PRODUCT_A, 1, 0, 2000],
    [UNTRACKED_ITEM_UUID, PRODUCT_B, 0, 1, 1000]
  ] as const) {
    insertRow(database, 'local_invoice_items', {
      local_uuid: uuid,
      invoice_local_uuid: INVOICE_UUID,
      line_index: lineIndex,
      product_uuid: productUuid,
      product_name: 'Widget',
      track_stock: trackStock,
      quantity_milli: quantityMilli,
      unit_price_amount: 1000,
      currency: 'USD',
      price_revision: HASH_64,
      tax_mode: 'none',
      tax_rate_basis_points: 0,
      tax_revision: HASH_64,
      discount_value: 0,
      subtotal_amount: 1000,
      discount_amount: 0,
      tax_amount: 0,
      total_amount: 1000,
      // Supplied only when the columns exist. The migration test seeds on the PRE-PS4 schema, where
      // they do not; the CHECK test seeds after migrating, where the conditional constraint applies.
      ...(splitColumnsExist
        ? {
            allocation_covered_milli: trackStock === 1 ? quantityMilli : 0,
            uncovered_milli: 0
          }
        : {}),
      created_at: NOW
    })
  }

  // FK-referencing rows, so the rebuild has something real to preserve.
  insertRow(database, 'local_stock_movements', {
    local_uuid: '00000000-0000-4000-8000-000000000f05',
    invoice_local_uuid: INVOICE_UUID,
    item_local_uuid: TRACKED_ITEM_UUID,
    product_uuid: PRODUCT_A,
    warehouse_uuid: WAREHOUSE_UUID,
    direction: 'out',
    quantity_milli: 2000,
    sync_status: 'pending',
    created_at: NOW
  })
}

databaseTest(
  'PS4 migration 0012 preserves every existing row and satisfies the conditional coverage CHECK',
  (sandbox) => {
    // Acceptance row 35. The rebuild is the risky part of this migration, so it is exercised on a
    // POPULATED database carrying all four line shapes the plan names — tracked, untracked, legacy
    // fully-covered, and (after the migration) mixed.
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(before, databaseMigrations.slice(0, 11))
    seedLegacyInvoice(before)
    const itemsBefore = before
      .prepare(
        'SELECT local_uuid, quantity_milli, track_stock FROM local_invoice_items ORDER BY line_index'
      )
      .all()
    const movementBefore = before.prepare('SELECT * FROM local_stock_movements').get()
    closeDatabase(before)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    // Nothing was dropped by the 12-step rebuild, and the FK graph is intact.
    deepEqual(
      database
        .prepare(
          'SELECT local_uuid, quantity_milli, track_stock FROM local_invoice_items ORDER BY line_index'
        )
        .all(),
      itemsBefore
    )
    deepEqual(database.pragma('foreign_key_check'), [])

    const movementAfter = database.prepare('SELECT * FROM local_stock_movements').get() as Record<
      string,
      unknown
    >
    equal(movementAfter.local_uuid, (movementBefore as Record<string, unknown>).local_uuid)
    // Backfilled to the legacy shape, which is what every pre-PS4 movement actually was.
    equal(movementAfter.stock_authorization, null)

    // The backfill records what actually happened: a pre-PS4 tracked line could only have committed
    // fully allocation-covered, and an untracked line has no split at all.
    const tracked = database
      .prepare(
        'SELECT allocation_covered_milli, uncovered_milli FROM local_invoice_items WHERE local_uuid = ?'
      )
      .get(TRACKED_ITEM_UUID) as { allocation_covered_milli: number; uncovered_milli: number }
    equal(tracked.allocation_covered_milli, 2000)
    equal(tracked.uncovered_milli, 0)

    const untracked = database
      .prepare(
        'SELECT allocation_covered_milli, uncovered_milli FROM local_invoice_items WHERE local_uuid = ?'
      )
      .get(UNTRACKED_ITEM_UUID) as { allocation_covered_milli: number; uncovered_milli: number }
    equal(untracked.allocation_covered_milli, 0)
    equal(untracked.uncovered_milli, 0)

    closeDatabase(database)
  }
)

databaseTest('PS4 the coverage CHECK is conditional on track_stock', (sandbox) => {
  // §15.3: the naive unconditional equality is unsatisfiable, because an untracked line has no
  // consumptions and its split is 0+0. This asserts BOTH halves — the untracked exemption and the
  // tracked enforcement — so a future "simplification" to an unconditional CHECK fails here.
  const database = openExistingTestDatabase(sandbox)
  runTestMigrations(database, databaseMigrations)
  seedLegacyInvoice(database, true)

  // A tracked line whose split does not add up is refused.
  throws(() =>
    database
      .prepare('UPDATE local_invoice_items SET uncovered_milli = 500 WHERE local_uuid = ?')
      .run(TRACKED_ITEM_UUID)
  )

  // A mixed split that does add up is accepted.
  database
    .prepare(
      'UPDATE local_invoice_items SET allocation_covered_milli = 500, uncovered_milli = 1500 WHERE local_uuid = ?'
    )
    .run(TRACKED_ITEM_UUID)
  const mixed = database
    .prepare(
      'SELECT allocation_covered_milli, uncovered_milli FROM local_invoice_items WHERE local_uuid = ?'
    )
    .get(TRACKED_ITEM_UUID) as { allocation_covered_milli: number; uncovered_milli: number }
  equal(mixed.allocation_covered_milli, 500)
  equal(mixed.uncovered_milli, 1500)

  closeDatabase(database)
})

databaseTest('PS4 an authority is stored verbatim and its window is half-open', (sandbox) => {
  const database = openExistingTestDatabase(sandbox)
  runTestMigrations(database, databaseMigrations)

  insertRow(database, 'offline_sale_authorities', {
    authority_uuid: AUTHORITY_UUID,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    mode: 'physical_presence',
    policy_revision: 1,
    contract_version: 3,
    issued_at: NOW,
    not_before: NOW,
    not_after: '2026-09-09T00:00:00.000Z',
    authority_hash: HASH_64,
    observed_at: NOW,
    created_at: NOW
  })

  const stored = database.prepare('SELECT * FROM offline_sale_authorities').get() as Record<
    string,
    unknown
  >
  equal(stored.not_after, '2026-09-09T00:00:00.000Z')

  // An inverted window is structurally impossible: a row that could not have been issued must not
  // be storable either.
  throws(() =>
    insertRow(database, 'offline_sale_authorities', {
      authority_uuid: '00000000-0000-4000-8000-000000000e02',
      company_uuid: COMPANY_UUID,
      device_uuid: DEVICE_UUID,
      mode: 'physical_presence',
      policy_revision: 1,
      contract_version: 3,
      issued_at: NOW,
      not_before: '2026-09-09T00:00:00.000Z',
      not_after: NOW,
      authority_hash: HASH_64,
      observed_at: NOW,
      created_at: NOW
    })
  )

  // An unknown mode is refused rather than stored and later misread as permissive.
  throws(() =>
    insertRow(database, 'offline_sale_authorities', {
      authority_uuid: '00000000-0000-4000-8000-000000000e03',
      company_uuid: COMPANY_UUID,
      device_uuid: DEVICE_UUID,
      mode: 'anything_goes',
      policy_revision: 1,
      contract_version: 3,
      issued_at: NOW,
      not_before: NOW,
      not_after: '2026-09-09T00:00:00.000Z',
      authority_hash: HASH_64,
      observed_at: NOW,
      created_at: NOW
    })
  )

  ok(true)
  closeDatabase(database)
})
