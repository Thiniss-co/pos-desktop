import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type { SqliteDatabase } from '../database/connection'

interface BootstrapStateRow {
  readonly is_complete: number
  readonly updated_at: string | null
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
}
