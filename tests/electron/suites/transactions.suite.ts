import { deepEqual, equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest('transactions commit multiple real repository writes together', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)

  database.transaction(() => {
    repositories.appSettings.set('transaction.setting', 'ready')
    repositories.sessionMetadata.establish({
      userName: 'Cashier',
      userEmail: 'cashier@example.test'
    })
  })()

  closeDatabase(database)
  deepEqual(
    readCommitted<{ value: string }>(sandbox, 'SELECT value FROM app_settings WHERE key = ?', [
      'transaction.setting'
    ]),
    [{ value: 'ready' }]
  )
  deepEqual(
    readCommitted<{ user_email: string }>(sandbox, 'SELECT user_email FROM auth_session_metadata'),
    [{ user_email: 'cashier@example.test' }]
  )
})

databaseTest('transactions roll back a real intermediate write', (sandbox) => {
  const database = openTestDatabase(sandbox)

  throws(() => {
    database.transaction(() => {
      database
        .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('rollback.setting', 'no', '2026-01-01T00:00:00Z')
      throw new Error('deliberate transaction failure')
    })()
  }, /deliberate transaction failure/)
  closeDatabase(database)

  deepEqual(
    readCommitted(sandbox, 'SELECT * FROM app_settings WHERE key = ?', ['rollback.setting']),
    []
  )
})

databaseTest(
  'SQLite uniqueness, foreign-key, and check constraints leave no partial state',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    database
      .prepare(
        'INSERT INTO sync_queue (local_queue_uuid, aggregate_type, local_aggregate_uuid, operation, payload_json, payload_hash, idempotency_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'invoice',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'create',
        '{}',
        'hash',
        'idempotency-1',
        'pending',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      )

    throws(
      () =>
        database
          .prepare(
            'INSERT INTO sync_queue (local_queue_uuid, aggregate_type, local_aggregate_uuid, operation, payload_json, payload_hash, idempotency_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'invoice',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'create',
            '{}',
            'hash',
            'idempotency-1',
            'pending',
            '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:00Z'
          ),
      /UNIQUE constraint failed/
    )
    throws(
      () =>
        database
          .prepare(
            'INSERT INTO product_barcodes (id, product_id, barcode, type, is_primary, is_active) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 404, '404', null, 1, 1),
      /FOREIGN KEY constraint failed/
    )
    throws(
      () =>
        database
          .prepare('UPDATE sync_queue SET state = ? WHERE local_queue_uuid = ?')
          .run('invented', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      /CHECK constraint failed/
    )
    closeDatabase(database)

    equal(readCommitted(sandbox, 'SELECT * FROM sync_queue').length, 1)
    equal(readCommitted(sandbox, 'SELECT * FROM product_barcodes').length, 0)
  }
)
