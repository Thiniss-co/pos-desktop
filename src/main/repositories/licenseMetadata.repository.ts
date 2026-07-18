import { licenseStatusSchema, type LicenseStatus } from '@shared/contracts/license.contract'
import type { SqliteDatabase } from '../database/connection'

interface LicenseMetadataRow {
  readonly status: string
  readonly updated_at: string
}

interface LicenseMetadataDetailsRow {
  readonly details_json: string | null
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

  set(status: LicenseStatus): void {
    this.database
      .prepare(
        `
          INSERT INTO license_state_metadata (id, status, updated_at, details_json)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            details_json = excluded.details_json
        `
      )
      .run(status.restrictionLevel, status.validatedAt, JSON.stringify(status))
  }

  getStatus(): LicenseStatus | null {
    const row = this.database
      .prepare('SELECT details_json FROM license_state_metadata WHERE id = 1')
      .get() as LicenseMetadataDetailsRow | undefined

    if (!row?.details_json) {
      return null
    }

    return licenseStatusSchema.parse(JSON.parse(row.details_json))
  }
}
