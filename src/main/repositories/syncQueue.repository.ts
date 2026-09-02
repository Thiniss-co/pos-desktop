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

/**
 * The immutable queued upload evidence for one local invoice. Read-only: Phase 3F has no upload
 * worker and no production consumer of these rows (plan §7f) — they exist so the completion path
 * can prove its own post-write invariants and so a committed-result replay can re-verify that the
 * queued payload was never mutated (plan §1.6 item 3).
 */
export interface SyncQueueUploadRow {
  readonly localQueueUuid: string
  readonly payloadJson: string
  readonly payloadHash: string
}

interface SyncQueueUploadDbRow {
  readonly local_queue_uuid: string
  readonly payload_json: string
  readonly payload_hash: string
}

interface SyncCountRow {
  readonly state: SyncQueueState
  readonly count: number
}

interface UpdateResult {
  readonly changes: number
}

export class SyncQueueRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  enqueue(item: NewSyncQueueItem): void {
    const timestamp = this.now()

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

  /**
   * Every `aggregate_type='invoice'`/`operation='upload'` row queued for one local invoice.
   * Deliberately returns **all** matches rather than a `LIMIT 1` row, so a caller asserting the
   * plan's "exactly one invoice/upload queue row" invariant sees a duplicate instead of silently
   * reading the first of several.
   */
  invoiceUploadRowsFor(localAggregateUuid: string): readonly SyncQueueUploadRow[] {
    const rows = this.database
      .prepare(
        `
          SELECT local_queue_uuid, payload_json, payload_hash
          FROM sync_queue
          WHERE aggregate_type = 'invoice'
            AND operation = 'upload'
            AND local_aggregate_uuid = ?
          ORDER BY local_queue_uuid ASC
        `
      )
      .all(localAggregateUuid) as SyncQueueUploadDbRow[]

    return rows.map((row) => ({
      localQueueUuid: row.local_queue_uuid,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash
    }))
  }

  transition(localQueueUuid: string, nextState: SyncQueueState): void {
    this.database.transaction(() => {
      const row = this.database
        .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
        .get(localQueueUuid) as SyncQueueRow | undefined

      if (!row || !isSyncQueueState(row.state)) {
        throw new Error('Sync queue item was not found')
      }

      if (!isSyncQueueTransitionAllowed(row.state, nextState)) {
        throw new Error(`Sync queue transition from ${row.state} to ${nextState} is not allowed`)
      }

      const result = this.database
        .prepare(
          'UPDATE sync_queue SET state = ?, updated_at = ? WHERE local_queue_uuid = ? AND state = ?'
        )
        .run(nextState, this.now(), localQueueUuid, row.state) as UpdateResult

      if (result.changes !== 1) {
        throw new Error('Sync queue item changed before its transition could be committed')
      }
    })()
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
