import type { SqliteDatabase } from '../database/connection'

export interface WorkspaceLayoutOwner {
  readonly companyUuid: string
  readonly userUuid: string
  readonly deviceUuid: string
}

/** POS workspace layout rows (migration 0033), one per company + user + workstation. */
export class WorkspaceLayoutRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /** The stored JSON text, or `null` when this owner has none (the caller applies the default). */
  get(owner: WorkspaceLayoutOwner): string | null {
    const value = this.database
      .prepare(
        `SELECT layout_json FROM user_workspace_layouts
         WHERE company_uuid = ? AND user_uuid = ? AND device_uuid = ?`
      )
      .pluck()
      .get(owner.companyUuid, owner.userUuid, owner.deviceUuid) as string | undefined
    return value ?? null
  }

  set(owner: WorkspaceLayoutOwner, layoutJson: string, schemaVersion: number, now: string): void {
    this.database
      .prepare(
        `INSERT INTO user_workspace_layouts
           (company_uuid, user_uuid, device_uuid, layout_json, schema_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_uuid, user_uuid, device_uuid)
         DO UPDATE SET layout_json = excluded.layout_json,
                       schema_version = excluded.schema_version,
                       updated_at = excluded.updated_at`
      )
      .run(owner.companyUuid, owner.userUuid, owner.deviceUuid, layoutJson, schemaVersion, now)
  }

  delete(owner: WorkspaceLayoutOwner): void {
    this.database
      .prepare(
        'DELETE FROM user_workspace_layouts WHERE company_uuid = ? AND user_uuid = ? AND device_uuid = ?'
      )
      .run(owner.companyUuid, owner.userUuid, owner.deviceUuid)
  }
}
