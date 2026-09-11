import Database from 'better-sqlite3'
import { equal, ok } from 'node:assert/strict'
import { databaseTest } from '../support/sandbox'
import {
  livePhysicalPresenceBackendAvailable,
  liveUploadFixture
} from '../support/liveUploadBackend'

const UPLOAD_PATH = '/api/v1/desktop/invoices/upload'

/**
 * PS7 — the physical-presence sale, end to end, over real HTTP against a real Laravel.
 *
 * This is §3's plain-language example executed rather than described: recorded stock is 20, the
 * cashier sells 22, the workstation holds **no allocation at all**, and the sale must still commit —
 * taking the recorded balance to -2 and opening a discrepancy.
 *
 * Everything below is asserted against the server's own database, not against the HTTP response.
 * A 201 alone would prove only that the request was accepted; the properties that matter are what
 * the ledger looks like afterwards.
 *
 * Skips when no live backend was provided, so `npm run test:sqlite:electron` stays hermetic.
 */
function liveTest(name: string, callback: () => Promise<void>): void {
  databaseTest(name, async () => await callback(), {
    skip: livePhysicalPresenceBackendAvailable()
      ? false
      : 'no live PS7 physical-presence backend provided'
  })
}

async function upload(body: Record<string, unknown>): Promise<Response> {
  const fixture = liveUploadFixture()
  ok(fixture !== null)

  return fetch(new URL(UPLOAD_PATH, fixture.origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      'X-Device-UUID': fixture.deviceUuid,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })
}

/**
 * Read the server's own row for a product, read-only.
 *
 * Quantities come back as milli INTEGERS rather than decimal strings. SQLite gives a
 * `decimal(14,3)` column NUMERIC affinity, so the stored `'20.000'` is returned by the driver as the
 * number `20` and the exact decimal text is simply not recoverable from this side. Rounding to
 * thousandths is exact at these magnitudes and keeps the assertion an integer comparison rather than
 * a float one. The BACKEND never does this — it reads through Eloquent's `decimal:3` cast and folds
 * through `App\Shared\Support\Quantity`; this is a constraint of reading its test database from
 * outside.
 */
function serverStock(productUuid: string): {
  quantityMilli: number
  availableQuantityMilli: number
  inventoryValueAmount: number
} | null {
  const path = process.env.CP3G5_BACKEND_DB

  ok(path, 'CP3G5_BACKEND_DB is required')

  const database = new Database(path, { readonly: true })

  try {
    const row = database
      .prepare(
        `SELECT s.quantity, s.available_quantity, s.inventory_value_amount
           FROM stock_items s
           JOIN products p ON p.id = s.product_id
          WHERE p.uuid = ?`
      )
      .get(productUuid) as
      { quantity: string; available_quantity: string; inventory_value_amount: number } | undefined

    return row
      ? {
          quantityMilli: Math.round(Number(row.quantity) * 1000),
          availableQuantityMilli: Math.round(Number(row.available_quantity) * 1000),
          inventoryValueAmount: row.inventory_value_amount
        }
      : null
  } finally {
    database.close()
  }
}

function serverScalar(sql: string, ...parameters: readonly unknown[]): number {
  const path = process.env.CP3G5_BACKEND_DB

  ok(path)

  const database = new Database(path, { readonly: true })

  try {
    return (database.prepare(sql).get(...parameters) as { total: number }).total
  } finally {
    database.close()
  }
}

liveTest(
  'PS7 cached stock 20, offline sale of 22 commits over real HTTP and records the deficit',
  async () => {
    // Acceptance rows 1, 2 and 4 in one live scenario, plus row 38's transport.
    const fixture = liveUploadFixture()
    ok(fixture !== null)

    const payload = fixture.physicalPresencePayloads[0]

    const productUuid = fixture.physicalPresenceProductUuid

    ok(payload && productUuid)

    const before = serverStock(productUuid)
    ok(before !== null)
    equal(before.quantityMilli, 20_000)

    const response = await upload(payload as Record<string, unknown>)
    equal(response.status, 201)

    const body = (await response.json()) as {
      data: { inventory_settlement?: { status: string; open_deficit_milli: number } }
    }

    // §15.2: an open deficit is reported as a SUCCESS, not an error.
    equal(body.data.inventory_settlement?.status, 'discrepancy_open')
    equal(body.data.inventory_settlement?.open_deficit_milli, -2000)

    const after = serverStock(productUuid)
    ok(after !== null)

    // 20 - 22 = -2, stored rather than clamped (Option A), and valued at the known basis of 10.
    equal(after.quantityMilli, -2_000)
    equal(after.availableQuantityMilli, -2_000)
    equal(after.inventoryValueAmount, -20)

    const offlineNumber = (payload as { offline_number: string }).offline_number

    equal(
      serverScalar(
        'SELECT COUNT(*) AS total FROM pos_invoices WHERE offline_number = ?',
        offlineNumber
      ),
      1
    )

    // Exactly one movement, flagged oversold, with the whole line uncovered — and NO allocation
    // consumption anywhere, because the device held no grant.
    equal(
      serverScalar(
        `SELECT COUNT(*) AS total FROM stock_movements m
           JOIN pos_invoices i ON i.id = m.pos_invoice_id
          WHERE i.offline_number = ? AND m.is_oversold = 1 AND m.uncovered_milli = 22000`,
        offlineNumber
      ),
      1
    )
    equal(
      serverScalar(
        `SELECT COUNT(*) AS total FROM stock_allocation_consumptions c
           WHERE c.invoice_idempotency_key = ?`,
        (payload as { idempotency_key: string }).idempotency_key
      ),
      0
    )

    // One discrepancy, open, with the deficit equal to the excess.
    equal(
      serverScalar(
        `SELECT COUNT(*) AS total FROM pos_stock_discrepancies d
           JOIN products p ON p.id = d.product_id
          WHERE p.uuid = ? AND d.status = 'open' AND d.quantity_deficit_milli = -2000`,
        productUuid
      ),
      1
    )
  }
)

liveTest('PS7 an exact replay over real HTTP writes nothing further', async () => {
  // Acceptance rows 16 and 18: the lost-acknowledgment case. The same frozen bytes must resolve to
  // the committed invoice, not deduct again.
  const fixture = liveUploadFixture()
  ok(fixture !== null)

  const payload = fixture.physicalPresencePayloads[0] as Record<string, unknown>
  const productUuid = fixture.physicalPresenceProductUuid

  ok(payload && productUuid)

  // The scenario above already committed it; this run may also be the first. Either way, the state
  // AFTER a replay must equal the state before it.
  await upload(payload)

  const before = serverStock(productUuid)
  const movementsBefore = serverScalar('SELECT COUNT(*) AS total FROM stock_movements')

  const replay = await upload(payload)

  // 200 duplicate, not 201.
  equal(replay.status, 200)

  const after = serverStock(productUuid)

  equal(after?.quantityMilli, before?.quantityMilli)
  equal(serverScalar('SELECT COUNT(*) AS total FROM stock_movements'), movementsBefore)
  equal(
    serverScalar(
      'SELECT COUNT(*) AS total FROM pos_invoices WHERE offline_number = ?',
      (payload as { offline_number: string }).offline_number
    ),
    1
  )
})
