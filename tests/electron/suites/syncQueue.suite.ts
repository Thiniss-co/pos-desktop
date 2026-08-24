import { equal, throws } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'

databaseTest('sync queue transitions serialize a state-guarded compare-and-swap', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const queue = realRepositories(database).syncQueue
  const queueUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  queue.enqueue({
    localQueueUuid: queueUuid,
    aggregateType: 'invoice',
    localAggregateUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operation: 'create',
    payloadJson: '{}',
    payloadHash: 'hash',
    idempotencyKey: 'interleaved-transition'
  })

  queue.transition(queueUuid, 'uploading')
  throws(() => queue.transition(queueUuid, 'uploading'), /not allowed/)
  closeDatabase(database)

  equal(
    readCommitted<{ state: string }>(
      sandbox,
      'SELECT state FROM sync_queue WHERE local_queue_uuid = ?',
      [queueUuid]
    )[0]?.state,
    'uploading'
  )
})
