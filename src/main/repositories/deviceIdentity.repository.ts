import type { StoredDeviceIdentity } from '../services/deviceIdentity.service'
import type { SqliteDatabase } from '../database/connection'

interface DeviceIdentityRow {
  readonly device_uuid: string
  readonly device_name: string
  readonly platform: string
  readonly os_version: string
  readonly app_version: string
  readonly is_registered: number
}

export class SqliteDeviceIdentityRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(): StoredDeviceIdentity | null {
    const row = this.database
      .prepare(
        `
          SELECT device_uuid, device_name, platform, os_version, app_version,
            CASE WHEN registered_at IS NULL THEN 0 ELSE 1 END AS is_registered
          FROM device_identity
          WHERE id = 1
        `
      )
      .get() as DeviceIdentityRow | undefined

    if (!row) {
      return null
    }

    return {
      deviceUuid: row.device_uuid,
      deviceName: row.device_name,
      platform: row.platform,
      osVersion: row.os_version,
      appVersion: row.app_version,
      isRegistered: row.is_registered === 1
    }
  }

  create(identity: StoredDeviceIdentity): void {
    const timestamp = new Date().toISOString()

    this.database
      .prepare(
        `
          INSERT INTO device_identity (
            id, device_uuid, device_name, platform, os_version, app_version, registered_at, created_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, NULL, ?, ?)
        `
      )
      .run(
        identity.deviceUuid,
        identity.deviceName,
        identity.platform,
        identity.osVersion,
        identity.appVersion,
        timestamp,
        timestamp
      )
  }

  markRegisteredWithBackend(registeredAt: string): void {
    this.database
      .prepare('UPDATE device_identity SET registered_at = ?, updated_at = ? WHERE id = 1')
      .run(registeredAt, registeredAt)
  }
}
