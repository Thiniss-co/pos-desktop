import type { SqliteDatabase } from '../database/connection'

interface LicenseMetadataRow {
  readonly status: string
  readonly updated_at: string
}

export interface LicenseMetadata {
  readonly status: string
  readonly updatedAt: string
}

export class LicenseMetadataRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(): LicenseMetadata | null {
    const row = this.database
      .prepare('SELECT status, updated_at FROM license_state_metadata WHERE id = 1')
      .get() as LicenseMetadataRow | undefined

    return row
      ? {
          status: row.status,
          updatedAt: row.updated_at
        }
      : null
  }
}
