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

export const LICENSE_TRUSTED_TIME_ANCHOR_KEY = 'license.trusted_time_anchor'

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
    this.persistStatus(status)
  }

  setValidatedStatus(status: LicenseStatus, trustedTimeAnchor: string): void {
    this.database.transaction(() => {
      this.persistStatus(status)
      this.database
        .prepare(
          `
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `
        )
        .run(LICENSE_TRUSTED_TIME_ANCHOR_KEY, trustedTimeAnchor, new Date().toISOString())
    })()
  }

  getTrustedTimeAnchor(): string | null {
    const row = this.database
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(LICENSE_TRUSTED_TIME_ANCHOR_KEY) as { readonly value: string } | undefined

    return row?.value ?? null
  }

  private persistStatus(status: LicenseStatus): void {
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

    try {
      const parsed = licenseStatusSchema.safeParse(JSON.parse(row.details_json))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}
