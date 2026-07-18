import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type { SqliteDatabase } from '../database/connection'

interface BootstrapStateRow {
  readonly is_complete: number
  readonly updated_at: string | null
}

export interface BootstrapSnapshotMeta {
  readonly snapshotVersion: string
  readonly serverTime: string
  readonly counts: Record<string, number>
}

export class BootstrapStateRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getStatus(): BootstrapStatus {
    const row = this.database
      .prepare('SELECT is_complete, updated_at FROM bootstrap_state WHERE id = 1')
      .get() as BootstrapStateRow | undefined

    return {
      isComplete: row?.is_complete === 1,
      updatedAt: row?.updated_at ?? null
    }
  }

  markComplete(meta: BootstrapSnapshotMeta): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO bootstrap_state (id, is_complete, updated_at, snapshot_version, server_time, counts_json)
          VALUES (1, 1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            is_complete = 1,
            updated_at = excluded.updated_at,
            snapshot_version = excluded.snapshot_version,
            server_time = excluded.server_time,
            counts_json = excluded.counts_json
        `
      )
      .run(timestamp, meta.snapshotVersion, meta.serverTime, JSON.stringify(meta.counts))
  }
}
