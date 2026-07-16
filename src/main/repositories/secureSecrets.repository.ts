import type { SqliteDatabase } from '../database/connection'

interface SecureSecretRow {
  readonly encrypted_value: Buffer
}

export class SecureSecretsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(key: string): Buffer | null {
    const row = this.database
      .prepare('SELECT encrypted_value FROM secure_secrets WHERE key = ?')
      .get(key) as SecureSecretRow | undefined

    return row?.encrypted_value ?? null
  }

  set(key: string, encryptedValue: Buffer): void {
    this.database
      .prepare(
        `
          INSERT INTO secure_secrets (key, encrypted_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            encrypted_value = excluded.encrypted_value,
            updated_at = excluded.updated_at
        `
      )
      .run(key, encryptedValue, new Date().toISOString())
  }

  delete(key: string): void {
    this.database.prepare('DELETE FROM secure_secrets WHERE key = ?').run(key)
  }
}
