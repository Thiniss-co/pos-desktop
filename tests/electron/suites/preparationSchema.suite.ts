import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { databaseTest } from '../support/sandbox'
import {
  openExistingTestDatabase,
  openTestDatabase,
  runTestMigrations
} from '../support/openTestDatabase'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  WAREHOUSE_UUID,
  insertRow
} from '../support/allocationScenario'

/*
 * CP3 — migration 0011 against a *populated* pre-migration database, and the schema-level
 * guarantees the preparation lifecycle depends on.
 *
 * The plan is explicit that a migration test which only proves a fresh database migrates proves very
 * little: §10 CP3 asks for "real Electron SQLite populated migration, rollback/failure recovery".
 * So every case below builds representative rows *first*, at the pre-0011 schema, and then migrates.
 */

const CYCLE_UUID = '00000000-0000-4000-8000-000000000101'
const OPERATION_UUID = '00000000-0000-4000-8000-000000000201'
const PRODUCT_A = '00000000-0000-4000-8000-0000000000a1'
const PRODUCT_B = '00000000-0000-4000-8000-0000000000b1'
const ALLOCATION_UUID = '00000000-0000-4000-8000-000000000301'

function queueRow(index: number): Record<string, unknown> {
  return {
    local_queue_uuid: `00000000-0000-4000-8000-00000000q${index}`.replace('q', '9'),
    aggregate_type: 'invoice',
    local_aggregate_uuid: `00000000-0000-4000-8000-00000000i${index}`.replace('i', '8'),
    operation: 'upload',
    payload_json: '{}',
    payload_hash: HASH_64,
    idempotency_key: `key-${index}`,
    state: 'pending',
    created_at: `2026-09-0${index}T00:00:00.000Z`,
    updated_at: `2026-09-0${index}T00:00:00.000Z`
  }
}

function captureCycle(database: ReturnType<typeof openTestDatabase>): void {
  insertRow(database, 'prepare_cycles', {
    cycle_uuid: CYCLE_UUID,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    requested_policy_revision: 1,
    captured_queue_high_water: 3,
    state: 'captured',
    captured_at: NOW,
    updated_at: NOW
  })
}

function freezeOperation(
  database: ReturnType<typeof openTestDatabase>,
  overrides: Record<string, unknown> = {}
): void {
  insertRow(database, 'prepare_operations', {
    operation_uuid: OPERATION_UUID,
    cycle_uuid: CYCLE_UUID,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    requested_policy_revision: 1,
    canonical_request_json: '{"prepare_contract_version":1}',
    request_hash: HASH_64,
    selected_product_uuids_json: JSON.stringify([PRODUCT_A, PRODUCT_B]),
    captured_session_epoch: 1,
    state: 'captured',
    captured_at: NOW,
    updated_at: NOW,
    ...overrides
  })
}

databaseTest(
  'CP3 migration 0011 backfills queue_sequence over populated rows in claim order',
  (sandbox) => {
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(before, databaseMigrations.slice(0, 10))

    // Three pre-existing queue rows, deliberately inserted out of chronological order so the backfill
    // has to sort rather than merely enumerate.
    insertRow(before, 'sync_queue', queueRow(3))
    insertRow(before, 'sync_queue', queueRow(1))
    insertRow(before, 'sync_queue', queueRow(2))
    const preserved = before
      .prepare('SELECT local_queue_uuid, idempotency_key FROM sync_queue ORDER BY idempotency_key')
      .all()
    closeDatabase(before)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    // Nothing existing is lost or rewritten.
    deepEqual(
      database
        .prepare(
          'SELECT local_queue_uuid, idempotency_key FROM sync_queue ORDER BY idempotency_key'
        )
        .all(),
      preserved
    )
    deepEqual(database.pragma('foreign_key_check'), [])

    // Backfilled in (created_at, local_queue_uuid) order — the same order `claimDue()` already uses,
    // so the high-water mark orders historical rows exactly as the queue itself does.
    const sequences = database
      .prepare('SELECT idempotency_key, queue_sequence FROM sync_queue ORDER BY queue_sequence')
      .all() as { idempotency_key: string; queue_sequence: number }[]

    deepEqual(
      sequences.map((row) => row.idempotency_key),
      ['key-1', 'key-2', 'key-3']
    )
    deepEqual(
      sequences.map((row) => row.queue_sequence),
      [1, 2, 3]
    )
    closeDatabase(database)
  }
)

databaseTest('CP3 a frozen request body and hash cannot be edited or re-hashed', (sandbox) => {
  const database = openTestDatabase(sandbox)
  captureCycle(database)
  freezeOperation(database)

  // §7.2 step 5: once dispatch begins — or once the outcome becomes ambiguous — neither the request
  // body nor the operation identity may change, for any reason. Enforced by the database, so a
  // future caller cannot quietly bypass it.
  throws(
    () =>
      database
        .prepare(
          'UPDATE prepare_operations SET canonical_request_json = ? WHERE operation_uuid = ?'
        )
        .run('{"edited":true}', OPERATION_UUID),
    /may not be edited or re-hashed/
  )
  throws(
    () =>
      database
        .prepare('UPDATE prepare_operations SET request_hash = ? WHERE operation_uuid = ?')
        .run('b'.repeat(64), OPERATION_UUID),
    /may not be edited or re-hashed/
  )
  throws(
    () =>
      database
        .prepare(
          'UPDATE prepare_operations SET selected_product_uuids_json = ? WHERE operation_uuid = ?'
        )
        .run(JSON.stringify([PRODUCT_A]), OPERATION_UUID),
    /may not be edited or re-hashed/
  )
  closeDatabase(database)
})

databaseTest(
  'CP3 preparation anchors cannot be rewritten and the window never lengthens',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    captureCycle(database)
    freezeOperation(database, {
      state: 'applied',
      prepared_at: '2026-09-09T10:00:00.000Z',
      required_duration_seconds: 259200,
      required_ready_until: '2026-09-12T10:00:00.000Z',
      authority_ready_until: '2026-09-12T10:00:00.000Z',
      result: 'ready_72h',
      primary_limiting_reason: 'required_window',
      manifest_json: '{}',
      authority_references_json: '{}',
      applied_at: NOW
    })

    // §8.5: neither `prepared_at` nor `authority_ready_until` is ever rewritten, and
    // `effective_ready_until` may only ever move earlier. A replay, bootstrap, delayed response, or
    // restart that tried to extend the window is a §13 stop condition.
    throws(
      () =>
        database
          .prepare('UPDATE prepare_operations SET prepared_at = ? WHERE operation_uuid = ?')
          .run('2026-09-09T12:00:00.000Z', OPERATION_UUID),
      /may not be rewritten or extended/
    )
    throws(
      () =>
        database
          .prepare(
            'UPDATE prepare_operations SET authority_ready_until = ? WHERE operation_uuid = ?'
          )
          .run('2026-09-13T10:00:00.000Z', OPERATION_UUID),
      /may not be rewritten or extended/
    )

    // Shortening is allowed and is the only permitted movement: a newly observed shorter
    // subscription, grace, license, catalog, session, or shift boundary shortens it.
    database
      .prepare('UPDATE prepare_operations SET authority_ready_until = ? WHERE operation_uuid = ?')
      .run('2026-09-11T10:00:00.000Z', OPERATION_UUID)

    equal(
      (
        database
          .prepare(
            'SELECT authority_ready_until AS value FROM prepare_operations WHERE operation_uuid = ?'
          )
          .get(OPERATION_UUID) as { value: string }
      ).value,
      '2026-09-11T10:00:00.000Z'
    )
    closeDatabase(database)
  }
)

databaseTest('CP3 terminal operation states are terminal', (sandbox) => {
  const database = openTestDatabase(sandbox)
  captureCycle(database)

  for (const terminal of ['conflicted', 'superseded_before_dispatch', 'superseded_uncommitted']) {
    const uuid = `${OPERATION_UUID.slice(0, -1)}${terminal.length % 10}`
    insertRow(database, 'prepare_operations', {
      operation_uuid: uuid,
      cycle_uuid: CYCLE_UUID,
      company_uuid: COMPANY_UUID,
      device_uuid: DEVICE_UUID,
      warehouse_uuid: WAREHOUSE_UUID,
      requested_policy_revision: 1,
      canonical_request_json: '{}',
      request_hash: HASH_64,
      selected_product_uuids_json: JSON.stringify([PRODUCT_A]),
      captured_session_epoch: 1,
      state: terminal,
      conflict_reason: terminal === 'conflicted' ? 'idempotency_conflict' : null,
      captured_at: NOW,
      updated_at: NOW
    })

    throws(
      () =>
        database
          .prepare('UPDATE prepare_operations SET state = ? WHERE operation_uuid = ?')
          .run('ambiguous', uuid),
      /terminal preparation operation state may not change/
    )
  }
  closeDatabase(database)
})

databaseTest('CP3 an applied operation cannot exist without its complete manifest', (sandbox) => {
  const database = openTestDatabase(sandbox)
  captureCycle(database)

  // §5.4 item 6: the decision, its outcomes, its links and its manifest commit together or not at
  // all. A torn application would land here, so the schema refuses it outright.
  throws(() =>
    freezeOperation(database, {
      state: 'applied',
      applied_at: NOW,
      prepared_at: '2026-09-09T10:00:00.000Z'
      // required_ready_until, authority_ready_until, result and manifest deliberately absent
    })
  )
  closeDatabase(database)
})

databaseTest(
  'CP3 a zero outcome carries no allocation link and a granted one always does',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    captureCycle(database)
    freezeOperation(database)

    // A decided zero and a missing decision must never be confusable (§5.4, §6.7), so the storage
    // makes "granted zero implies no allocation" and "granted more than zero implies an allocation"
    // structural facts rather than conventions.
    insertRow(database, 'prepare_operation_outcomes', {
      operation_uuid: OPERATION_UUID,
      product_uuid: PRODUCT_A,
      reason: 'zero_cap',
      granted_quantity_milli: 0,
      allocation_uuid: null
    })
    insertRow(database, 'prepare_operation_outcomes', {
      operation_uuid: OPERATION_UUID,
      product_uuid: PRODUCT_B,
      reason: 'full',
      granted_quantity_milli: 30_000,
      allocation_uuid: ALLOCATION_UUID
    })

    throws(() =>
      insertRow(database, 'prepare_operation_outcomes', {
        operation_uuid: OPERATION_UUID,
        product_uuid: '00000000-0000-4000-8000-0000000000c1',
        reason: 'zero_stock',
        granted_quantity_milli: 0,
        allocation_uuid: ALLOCATION_UUID
      })
    )
    throws(() =>
      insertRow(database, 'prepare_operation_outcomes', {
        operation_uuid: OPERATION_UUID,
        product_uuid: '00000000-0000-4000-8000-0000000000d1',
        reason: 'full',
        granted_quantity_milli: 10_000,
        allocation_uuid: null
      })
    )

    equal(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS total FROM prepare_operation_outcomes WHERE operation_uuid = ?'
          )
          .get(OPERATION_UUID) as { total: number }
      ).total,
      2
    )
    closeDatabase(database)
  }
)

databaseTest('CP3 migration 0011 rolls all schema work back on failure', (sandbox) => {
  const database = openExistingTestDatabase(sandbox)
  // Addressed by version, not by position, so a later checkpoint appending migration 0012 does not
  // silently repoint this test at it.
  const migration = databaseMigrations.find((candidate) => candidate.version === 11)
  ok(migration, 'Migration 0011 is missing')

  const failing = {
    ...migration,
    up(target: Parameters<typeof migration.up>[0]): void {
      migration.up(target)
      throw new Error('injected failure after schema work')
    }
  }

  throws(() => runTestMigrations(database, [...databaseMigrations.slice(0, 10), failing]))

  // Nothing from the failed migration survives: SQLite gives real transactional DDL, so this is a
  // genuine rollback assertion rather than the forward-repair exercise MySQL requires.
  equal(
    (
      database
        .prepare(`SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'prepare_operations'`)
        .get() as { total: number }
    ).total,
    0
  )
  closeDatabase(database)
})
