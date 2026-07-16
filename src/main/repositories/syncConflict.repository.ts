import type { SqliteDatabase } from '../database/connection'

export interface SyncConflictRecord {
  readonly localQueueUuid: string
  readonly conflictCode: string
  readonly localPayloadJson: string
  readonly reportedDetails?: string
}

export class SyncConflictRepository {
  constructor(private readonly database: SqliteDatabase) {}

  record(conflict: SyncConflictRecord): void {
    this.database
      .prepare(
        `
          INSERT INTO sync_conflicts (
            local_queue_uuid, conflict_code, local_payload_json, reported_details, created_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(local_queue_uuid) DO UPDATE SET
            conflict_code = excluded.conflict_code,
            local_payload_json = excluded.local_payload_json,
            reported_details = excluded.reported_details,
            created_at = excluded.created_at
        `
      )
      .run(
        conflict.localQueueUuid,
        conflict.conflictCode,
        conflict.localPayloadJson,
        conflict.reportedDetails ?? null,
        new Date().toISOString()
      )
  }
}
