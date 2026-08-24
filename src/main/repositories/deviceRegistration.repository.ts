import type { SqliteDatabase } from '../database/connection'

export interface DeviceRegistrationRecord {
  readonly serverDeviceId: string
  readonly status: string
  readonly lastSeenAt: string | null
  readonly updatedAt: string
}

export class DeviceRegistrationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  set(record: DeviceRegistrationRecord): void {
    this.database
      .prepare(
        `
          INSERT INTO device_registration (id, server_device_id, status, last_seen_at, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            server_device_id = excluded.server_device_id,
            status = excluded.status,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `
      )
      .run(record.serverDeviceId, record.status, record.lastSeenAt, record.updatedAt)
  }

  get(): DeviceRegistrationRecord | null {
    const row = this.database
      .prepare(
        'SELECT server_device_id, status, last_seen_at, updated_at FROM device_registration WHERE id = 1'
      )
      .get() as
      | {
          readonly server_device_id: string
          readonly status: string
          readonly last_seen_at: string | null
          readonly updated_at: string
        }
      | undefined

    return row
      ? {
          serverDeviceId: row.server_device_id,
          status: row.status,
          lastSeenAt: row.last_seen_at,
          updatedAt: row.updated_at
        }
      : null
  }
}
