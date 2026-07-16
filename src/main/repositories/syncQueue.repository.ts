import {
  type SyncQueueState,
  isSyncQueueState,
  isSyncQueueTransitionAllowed
} from '@shared/constants/syncQueueStates'
import type { SyncCounts, SyncStatus } from '@shared/contracts/sync.contract'
import type { SqliteDatabase } from '../database/connection'

export interface NewSyncQueueItem {
  readonly localQueueUuid: string
  readonly aggregateType: string
  readonly localAggregateUuid: string
  readonly operation: string
  readonly payloadJson: string
  readonly payloadHash: string
  readonly idempotencyKey: string
  readonly dependencyQueueUuid?: string
}

interface SyncQueueRow {
  readonly state: string
}

interface SyncCountRow {
  readonly state: SyncQueueState
  readonly count: number
}

export class SyncQueueRepository {
  constructor(private readonly database: SqliteDatabase) {}

  enqueue(item: NewSyncQueueItem): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO sync_queue (
            local_queue_uuid, aggregate_type, local_aggregate_uuid, operation, payload_json, payload_hash,
            idempotency_key, state, dependency_queue_uuid, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `
      )
      .run(
        item.localQueueUuid,
        item.aggregateType,
        item.localAggregateUuid,
        item.operation,
        item.payloadJson,
        item.payloadHash,
        item.idempotencyKey,
        item.dependencyQueueUuid ?? null,
        timestamp,
        timestamp
      )
  }

  transition(localQueueUuid: string, nextState: SyncQueueState): void {
    const row = this.database
      .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
      .get(localQueueUuid) as SyncQueueRow | undefined

    if (!row || !isSyncQueueState(row.state)) {
      throw new Error('Sync queue item was not found')
    }

    if (!isSyncQueueTransitionAllowed(row.state, nextState)) {
      throw new Error(`Sync queue transition from ${row.state} to ${nextState} is not allowed`)
    }

    this.database
      .prepare('UPDATE sync_queue SET state = ?, updated_at = ? WHERE local_queue_uuid = ?')
      .run(nextState, new Date().toISOString(), localQueueUuid)
  }

  getStatus(): SyncStatus {
    const rows = this.database
      .prepare('SELECT state, COUNT(*) AS count FROM sync_queue GROUP BY state')
      .all() as SyncCountRow[]
    const counts: SyncCounts = {
      pending: 0,
      uploading: 0,
      retryableError: 0,
      conflict: 0,
      rejected: 0
    }

    for (const row of rows) {
      if (row.state === 'pending') counts.pending = row.count
      if (row.state === 'uploading') counts.uploading = row.count
      if (row.state === 'retryable_error') counts.retryableError = row.count
      if (row.state === 'conflict') counts.conflict = row.count
      if (row.state === 'rejected') counts.rejected = row.count
    }

    return {
      state: 'idle',
      pausedReason: null,
      counts
    }
  }
}
