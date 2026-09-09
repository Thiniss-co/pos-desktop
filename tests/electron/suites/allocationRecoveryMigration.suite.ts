import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import { databaseTest } from '../support/sandbox'
import { openExistingTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import { COMPANY_UUID, DEVICE_UUID, HASH_64, NOW, insertRow } from '../support/allocationScenario'

const ALLOCATION_UUID = '00000000-0000-4000-8000-000000000441'

databaseTest(
  'BH-04B-4 migration 0010 is additive and retains every pre-existing hold',
  (sandbox) => {
    const before = openExistingTestDatabase(sandbox)
    runTestMigrations(before, databaseMigrations.slice(0, 9))
    insertRow(before, 'stock_allocation_holds', {
      allocation_uuid: ALLOCATION_UUID,
      rights_generation: 1,
      reason: 'coverage_conflict',
      detail: 'retained',
      created_at: NOW
    })
    const hold = before.prepare('SELECT * FROM stock_allocation_holds').get()
    closeDatabase(before)

    const database = openExistingTestDatabase(sandbox)
    runTestMigrations(database, databaseMigrations)

    deepEqual(database.prepare('SELECT * FROM stock_allocation_holds').get(), hold)
    deepEqual(database.pragma('foreign_key_check'), [])

    insertRow(database, 'stock_allocation_recoveries', {
      allocation_uuid: ALLOCATION_UUID,
      rights_generation: 1,
      company_uuid: COMPANY_UUID,
      device_uuid: DEVICE_UUID,
      state: 'intent',
      request_seal_idempotency_key: '00000000-0000-4000-8000-000000000442',
      expected_lifecycle_generation: 1,
      intent_created_at: NOW,
      updated_at: NOW
    })
    equal(
      (database.prepare('SELECT state FROM stock_allocation_recoveries').get() as { state: string })
        .state,
      'intent'
    )
    throws(() =>
      insertRow(database, 'stock_allocation_recoveries', {
        allocation_uuid: '00000000-0000-4000-8000-000000000443',
        rights_generation: 1,
        company_uuid: COMPANY_UUID,
        device_uuid: DEVICE_UUID,
        state: 'sealed',
        request_seal_idempotency_key: '00000000-0000-4000-8000-000000000444',
        expected_lifecycle_generation: 1,
        intent_created_at: NOW,
        updated_at: NOW
      })
    )
    closeDatabase(database)
  }
)

databaseTest('BH-04B-4 migration 0010 rolls all schema work back on failure', (sandbox) => {
  const database = openExistingTestDatabase(sandbox)
  const migration = databaseMigrations.at(-1)
  if (!migration) throw new Error('Migration 0010 is missing')

  const failing = {
    ...migration,
    up(target: Parameters<typeof migration.up>[0]): void {
      migration.up(target)
      insertRow(target, 'stock_allocation_recoveries', {
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        company_uuid: COMPANY_UUID,
        device_uuid: DEVICE_UUID,
        state: 'intent',
        request_seal_idempotency_key: HASH_64,
        expected_lifecycle_generation: 1,
        intent_created_at: NOW,
        updated_at: NOW
      })
      throw new Error('injected migration failure')
    }
  }

  throws(
    () => runTestMigrations(database, [...databaseMigrations.slice(0, 9), failing]),
    /injected migration failure/
  )
  equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'stock_allocation_recover%'"
      )
      .pluck()
      .get(),
    0
  )
  equal(
    database.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 10').pluck().get(),
    0
  )
  closeDatabase(database)
})
