import { OwnerChangedError, type RenewalOwner } from './renewalOwner'

/**
 * Phase 6, criterion C3 — ordering of access-bearing answers (license validation, bootstrap).
 *
 * The server advances a per-device `access_sequence` under the device row lock in the same transaction that evaluates
 * the device's access, and returns it as `meta.access_sequence`. A higher sequence therefore always describes a LATER
 * evaluation; clocks (server time, local time, equal or skewed timestamps) play no part.
 *
 * Inside the single SQLite transaction that writes an answer (after the renewal-owner re-check), the answer is admitted
 * only if its sequence is strictly greater than the last one accepted for the same device in the same session epoch,
 * and the new sequence is stored in that same transaction — so a restart keeps it together with the state it ordered.
 *
 * Compatibility: an answer WITHOUT a sequence (an older backend) is admitted as before, except that once this session
 * has accepted a sequenced answer, an unsequenced one may never RELAX access (it may still restrict it, and the stored
 * sequence is kept). A new session (sign-in, epoch change) or another device starts a fresh order: answers requested
 * before it are already discarded by the renewal-owner check. This is also the recovery path after a backend rollback:
 * sign out and in again, or bring the sequencing backend back (its next, higher sequence is admitted).
 */

export const ACCESS_SEQUENCE_SETTING_KEY = 'license.access_sequence'

export interface StoredAccessSequence {
  readonly deviceUuid: string
  readonly sessionEpoch: number
  readonly sequence: number
}

export interface AccessSequenceStore {
  get(): StoredAccessSequence | null
  set(value: StoredAccessSequence): void
}

export class StaleAccessResponseError extends OwnerChangedError {
  constructor(
    readonly received: number | null,
    readonly accepted: number
  ) {
    super()
    this.name = 'StaleAccessResponseError'
    this.message = `An older access answer (sequence ${received ?? 'none'}) arrived after a newer one (sequence ${accepted}); it was discarded.`
  }
}

/** The server's `meta.access_sequence`, or null when absent or malformed (treated as an older backend). */
export function accessSequenceFromMeta(
  meta: Record<string, unknown> | null | undefined
): number | null {
  const value = meta?.access_sequence
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Admits one answer or throws StaleAccessResponseError (nothing of that answer may be written). Must run inside the
 * answer's write transaction, after the owner re-check. `relaxes` says whether applying the answer could widen access
 * compared with what is stored now (only consulted for an unsequenced answer).
 */
export function admitAccessAnswer(
  store: AccessSequenceStore,
  owner: RenewalOwner | null,
  sequence: number | null,
  relaxes: boolean
): void {
  if (owner === null) {
    return
  }

  const stored = store.get()
  const current =
    stored !== null &&
    stored.deviceUuid === owner.deviceUuid &&
    stored.sessionEpoch === owner.sessionEpoch
      ? stored
      : null

  if (sequence === null) {
    if (current !== null && relaxes) {
      throw new StaleAccessResponseError(null, current.sequence)
    }
    return
  }

  if (current !== null && sequence <= current.sequence) {
    throw new StaleAccessResponseError(sequence, current.sequence)
  }

  store.set({ deviceUuid: owner.deviceUuid, sessionEpoch: owner.sessionEpoch, sequence })
}

/** The `app_settings` row that holds the last accepted sequence (written in the caller's transaction). */
export class SettingsAccessSequenceStore implements AccessSequenceStore {
  constructor(
    private readonly settings: {
      get(key: string): string | null
      set(key: string, value: string): void
    }
  ) {}

  get(): StoredAccessSequence | null {
    const raw = this.settings.get(ACCESS_SEQUENCE_SETTING_KEY)
    if (raw === null) {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredAccessSequence>
      return typeof parsed.deviceUuid === 'string' &&
        typeof parsed.sessionEpoch === 'number' &&
        typeof parsed.sequence === 'number'
        ? {
            deviceUuid: parsed.deviceUuid,
            sessionEpoch: parsed.sessionEpoch,
            sequence: parsed.sequence
          }
        : null
    } catch {
      return null
    }
  }

  set(value: StoredAccessSequence): void {
    this.settings.set(ACCESS_SEQUENCE_SETTING_KEY, JSON.stringify(value))
  }
}

/** What a bootstrap answer is compared with to tell whether an UNSEQUENCED one would relax access. */
export interface StoredBootstrapAccess {
  readonly canSell: boolean
  readonly canSync: boolean
  readonly enabledFeatures: ReadonlySet<string>
  readonly permissions: ReadonlySet<string>
}

/** The access-bearing parts of a bootstrap answer (license block, features, permissions). */
export interface BootstrapAccessParts {
  readonly license: { readonly can_sell: boolean; readonly can_sync: boolean }
  readonly features: Readonly<Record<string, boolean>>
  readonly permissions: readonly string[]
}

/**
 * Whether applying a bootstrap answer could widen access compared with what is stored: selling or syncing allowed where
 * the stored license status refuses it, a feature enabled that is not enabled now, or a permission not held now. With
 * nothing stored, every answer counts as relaxing. Device status is covered by the license block (a blocked or
 * revoked device answers `can_sell`/`can_sync` false).
 */
export function bootstrapRelaxes(
  answer: BootstrapAccessParts,
  stored: StoredBootstrapAccess | null
): boolean {
  if (stored === null) {
    return true
  }

  return (
    (answer.license.can_sell && !stored.canSell) ||
    (answer.license.can_sync && !stored.canSync) ||
    Object.entries(answer.features).some(
      ([code, enabled]) => enabled && !stored.enabledFeatures.has(code)
    ) ||
    answer.permissions.some((permission) => !stored.permissions.has(permission))
  )
}

/** Reads the stored access a bootstrap answer is compared with (license status, enabled features, permissions). */
export function storedBootstrapAccess(sources: {
  readonly license: { getStatus(): { readonly canSell: boolean; readonly canSync: boolean } | null }
  readonly snapshot: { getEnabledFeatures(): string[]; getPermissions(): string[] }
}): StoredBootstrapAccess | null {
  const status = sources.license.getStatus()

  return status === null
    ? null
    : {
        canSell: status.canSell,
        canSync: status.canSync,
        enabledFeatures: new Set(sources.snapshot.getEnabledFeatures()),
        permissions: new Set(sources.snapshot.getPermissions())
      }
}
