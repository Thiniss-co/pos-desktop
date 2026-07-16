import type { SqliteDatabase } from '../database/connection'

interface SettingRow {
  readonly value: string
}

export class AppSettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      SettingRow | undefined

    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.database
      .prepare(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `
      )
      .run(key, value, new Date().toISOString())
  }
}
