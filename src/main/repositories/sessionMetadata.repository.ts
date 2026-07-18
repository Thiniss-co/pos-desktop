import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { SqliteDatabase } from '../database/connection'

interface SessionMetadataRow {
  readonly user_name: string | null
  readonly user_email: string | null
}

export interface SessionEstablishInput {
  readonly userName: string
  readonly userEmail: string
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

  establish(input: SessionEstablishInput): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO auth_session_metadata (id, user_name, user_email, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_name = excluded.user_name,
            user_email = excluded.user_email,
            updated_at = excluded.updated_at
        `
      )
      .run(input.userName, input.userEmail, timestamp)
  }

  clear(): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO auth_session_metadata (id, user_name, user_email, updated_at)
          VALUES (1, NULL, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_name = NULL,
            user_email = NULL,
            updated_at = excluded.updated_at
        `
      )
      .run(timestamp)
  }
}
