import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { SqliteDatabase } from '../database/connection'

interface SessionMetadataRow {
  readonly user_name: string | null
  readonly user_email: string | null
}

export class SqliteSessionMetadataRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getSummary(): SessionSummary {
    const row = this.database
      .prepare('SELECT user_name, user_email FROM auth_session_metadata WHERE id = 1')
      .get() as SessionMetadataRow | undefined

    return {
      isAuthenticated: Boolean(row?.user_email),
      userName: row?.user_name ?? null,
      userEmail: row?.user_email ?? null
    }
  }
}
