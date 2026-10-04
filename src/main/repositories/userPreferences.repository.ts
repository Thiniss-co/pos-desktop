import type { SqliteDatabase } from '../database/connection'
import type { UserPreferenceKey } from '@shared/contracts/preferences.contract'

export interface PreferenceOwner {
  readonly companyUuid: string
  readonly userUuid: string
}

/** POS improvements, Stage 5: per-user boolean preferences (migration 0023). */
export class UserPreferencesRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /** The stored value, or `null` when this user never chose (the caller applies the default). */
  get(owner: PreferenceOwner, key: UserPreferenceKey): boolean | null {
    const value = this.database
      .prepare(
        'SELECT value FROM user_preferences WHERE company_uuid = ? AND user_uuid = ? AND key = ?'
      )
      .pluck()
      .get(owner.companyUuid, owner.userUuid, key) as string | undefined
    return value === undefined ? null : value === 'true'
  }

  set(owner: PreferenceOwner, key: UserPreferenceKey, value: boolean, now: string): void {
    this.database
      .prepare(
        `INSERT INTO user_preferences (company_uuid, user_uuid, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (company_uuid, user_uuid, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(owner.companyUuid, owner.userUuid, key, value ? 'true' : 'false', now)
  }
}
