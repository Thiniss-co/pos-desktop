import type { SqliteDatabase } from '../database/connection'

interface SessionEpochRow {
  readonly value: number
}

/**
 * The session generation is deliberately independent of auth_session_metadata so clearing the
 * current-session row can never reset it. Its only steady-state mutation is value = value + 1.
 */
export class SessionEpochRepository {
  constructor(private readonly database: SqliteDatabase) {}

  current(): number {
    this.ensureSingleton()
    return this.readCurrent()
  }

  increment(): number {
    this.ensureSingleton()
    this.database.prepare('UPDATE session_epoch SET value = value + 1 WHERE id = 1').run()
    return this.readCurrent()
  }

  private ensureSingleton(): void {
    this.database
      .prepare('INSERT INTO session_epoch (id, value) VALUES (1, 1) ON CONFLICT(id) DO NOTHING')
      .run()
  }

  private readCurrent(): number {
    const row = this.database.prepare('SELECT value FROM session_epoch WHERE id = 1').get() as
      SessionEpochRow | undefined

    if (!row) {
      throw new Error('The session epoch singleton is unavailable')
    }

    return row.value
  }
}
