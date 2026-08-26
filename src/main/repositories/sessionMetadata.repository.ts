import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { SqliteDatabase } from '../database/connection'

interface SessionMetadataRow {
  readonly user_name: string | null
  readonly user_email: string | null
  readonly user_uuid: string | null
  readonly user_is_active: number
  readonly company_uuid: string | null
  readonly device_uuid: string | null
  readonly server_device_id: string | null
}

export interface SessionEstablishInput {
  readonly userName: string
  readonly userEmail: string
  readonly userUuid?: string | null
  readonly userIsActive?: boolean
  readonly companyUuid?: string | null
  readonly deviceUuid?: string | null
  readonly serverDeviceId?: string | null
}

export interface SessionContext {
  readonly isAuthenticated: boolean
  readonly userUuid: string | null
  readonly userIsActive: boolean
  readonly companyUuid: string | null
  readonly deviceUuid: string | null
  readonly serverDeviceId: string | null
}

export class SqliteSessionMetadataRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getSummary(): SessionSummary {
    const row = this.database
      .prepare(
        `
          SELECT user_name, user_email, user_uuid, user_is_active, company_uuid,
            device_uuid, server_device_id
          FROM auth_session_metadata WHERE id = 1
        `
      )
      .get() as SessionMetadataRow | undefined

    return {
      isAuthenticated: Boolean(row?.user_email),
      userName: row?.user_name ?? null,
      userEmail: row?.user_email ?? null
    }
  }

  getContext(): SessionContext {
    const row = this.database
      .prepare(
        `
          SELECT user_name, user_email, user_uuid, user_is_active, company_uuid,
            device_uuid, server_device_id
          FROM auth_session_metadata WHERE id = 1
        `
      )
      .get() as SessionMetadataRow | undefined

    return {
      isAuthenticated: Boolean(row?.user_email && row.user_uuid),
      userUuid: row?.user_uuid ?? null,
      userIsActive: row?.user_is_active === 1,
      companyUuid: row?.company_uuid ?? null,
      deviceUuid: row?.device_uuid ?? null,
      serverDeviceId: row?.server_device_id ?? null
    }
  }

  establish(input: SessionEstablishInput): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO auth_session_metadata (
            id, user_name, user_email, user_uuid, user_is_active, company_uuid,
            device_uuid, server_device_id, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_name = excluded.user_name,
            user_email = excluded.user_email,
            user_uuid = excluded.user_uuid,
            user_is_active = excluded.user_is_active,
            company_uuid = excluded.company_uuid,
            device_uuid = excluded.device_uuid,
            server_device_id = excluded.server_device_id,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.userName,
        input.userEmail,
        input.userUuid ?? null,
        input.userIsActive ? 1 : 0,
        input.companyUuid ?? null,
        input.deviceUuid ?? null,
        input.serverDeviceId ?? null,
        timestamp
      )
  }

  clear(): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO auth_session_metadata (
            id, user_name, user_email, user_uuid, user_is_active, company_uuid,
            device_uuid, server_device_id, updated_at
          ) VALUES (1, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_name = NULL,
            user_email = NULL,
            user_uuid = NULL,
            user_is_active = 0,
            company_uuid = NULL,
            device_uuid = NULL,
            server_device_id = NULL,
            updated_at = excluded.updated_at
        `
      )
      .run(timestamp)
  }
}
