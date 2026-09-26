import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import { canonicalJson, sha256Hex } from '../services/localSale.fingerprint'

/**
 * Receipt-printing plan §D-11 — the company receipt-profile MIRROR. Laravel is authoritative
 * (§D-10); this repository only ever records what a negotiated bootstrap response or an admin
 * publish response already returned. It never invents a profile, a version or a revision.
 */

export interface ReceiptProfileFields {
  readonly addressLines: readonly string[]
  readonly phone: string | null
  readonly taxIdentifierLabel: string | null
  readonly taxIdentifierValue: string | null
  readonly footerLines: readonly string[]
}

export interface IncomingReceiptProfileLogo {
  readonly sha256: string
  readonly mediaType: string
  readonly widthPx: number
  readonly heightPx: number
  readonly byteLength: number
}

export interface IncomingReceiptProfileVersion extends ReceiptProfileFields {
  readonly versionUuid: string
  readonly revision: number
  readonly logo: IncomingReceiptProfileLogo | null
}

export interface ReceiptProfileVersionRow extends ReceiptProfileFields {
  readonly versionUuid: string
  readonly companyUuid: string
  readonly revision: number
  readonly logoSha256: string | null
  readonly logoAvailable: boolean
  readonly receivedAt: string
}

export interface ReceiptProfileCurrent {
  readonly versionUuid: string | null
  readonly capability: 'unsupported' | 'supported'
}

export interface ReceiptProfileAssetRow {
  readonly companyUuid: string
  readonly sha256: string
  readonly mediaType: string
  readonly widthPx: number
  readonly heightPx: number
  readonly byteLength: number
  readonly content: Buffer | null
  readonly status: 'pending' | 'available'
}

/**
 * Correction B — the monotonic-revision ingest protocol. Applies EITHER a negotiated bootstrap
 * block OR an admin-publish response through the exact same rules, so the two entry points can
 * never disagree about what "newer" means:
 *
 *  - `block === undefined` (bootstrap did not negotiate the block this round): no mirror change.
 *  - `block.profile === null` (the company has never published a profile): the pointer is left
 *    exactly as it is. A profile, once published, is never later reported as absent by this
 *    backend (versions are insert-only and the pointer only ever advances), so this is never a
 *    regression to guard against — it only guards a company that has genuinely never published.
 *  - An incoming version already known at that exact revision, with the SAME uuid and fields, is
 *    an idempotent replay: no re-insert, and the pointer is still (re-)considered for advancement.
 *  - An incoming version at a revision already known LOCALLY under a DIFFERENT uuid or different
 *    field content is a contract violation (revisions are supposed to be stable identities) and is
 *    rejected outright: never inserted, never moves the pointer, and is reported back to the
 *    caller so it can be traced without ever crashing bootstrap or blocking a sale.
 *  - The pointer only ever advances to a STRICTLY HIGHER revision than the one it already names.
 *    A lower/older revision arriving late (e.g. a slow bootstrap response overtaken by a faster
 *    `publish()` response) is retained as history (if new) but never becomes current.
 */
export type ReceiptProfileIngestOutcome =
  | { readonly kind: 'skipped_not_negotiated' }
  | { readonly kind: 'no_profile' }
  | { readonly kind: 'applied'; readonly versionUuid: string; readonly pointerMoved: boolean }
  | { readonly kind: 'idempotent_replay'; readonly versionUuid: string }
  | { readonly kind: 'rejected_revision_conflict'; readonly revision: number }

function fieldsJsonFor(fields: ReceiptProfileFields): string {
  return canonicalJson({
    addressLines: fields.addressLines,
    phone: fields.phone,
    taxIdentifierLabel: fields.taxIdentifierLabel,
    taxIdentifierValue: fields.taxIdentifierValue,
    footerLines: fields.footerLines
  })
}

interface VersionRow {
  version_uuid: string
  company_uuid: string
  revision: number
  fields_json: string
  fields_sha256: string
  logo_sha256: string | null
  received_at: string
}

function parseFields(fieldsJson: string): ReceiptProfileFields {
  const parsed = JSON.parse(fieldsJson) as {
    addressLines?: unknown
    phone?: unknown
    taxIdentifierLabel?: unknown
    taxIdentifierValue?: unknown
    footerLines?: unknown
  }
  return {
    addressLines: Array.isArray(parsed.addressLines) ? (parsed.addressLines as string[]) : [],
    phone: typeof parsed.phone === 'string' ? parsed.phone : null,
    taxIdentifierLabel:
      typeof parsed.taxIdentifierLabel === 'string' ? parsed.taxIdentifierLabel : null,
    taxIdentifierValue:
      typeof parsed.taxIdentifierValue === 'string' ? parsed.taxIdentifierValue : null,
    footerLines: Array.isArray(parsed.footerLines) ? (parsed.footerLines as string[]) : []
  }
}

export class ReceiptProfileRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getCurrent(companyUuid: string): ReceiptProfileCurrent | null {
    const row = this.database
      .prepare(
        'SELECT version_uuid AS versionUuid, capability FROM receipt_profile_current WHERE company_uuid = ?'
      )
      .get(companyUuid) as ReceiptProfileCurrent | undefined
    return row ?? null
  }

  getVersion(versionUuid: string, companyUuid: string): ReceiptProfileVersionRow | null {
    const row = this.database
      .prepare(
        `SELECT v.version_uuid, v.company_uuid, v.revision, v.fields_json, v.fields_sha256,
                v.logo_sha256, v.received_at,
                a.status AS logo_status
         FROM receipt_profile_versions v
         LEFT JOIN receipt_profile_assets a
           ON a.company_uuid = v.company_uuid AND a.sha256 = v.logo_sha256
         WHERE v.version_uuid = ? AND v.company_uuid = ?`
      )
      .get(versionUuid, companyUuid) as (VersionRow & { logo_status: string | null }) | undefined

    if (!row) {
      return null
    }

    return {
      versionUuid: row.version_uuid,
      companyUuid: row.company_uuid,
      revision: row.revision,
      ...parseFields(row.fields_json),
      logoSha256: row.logo_sha256,
      logoAvailable: row.logo_status === 'available',
      receivedAt: row.received_at
    }
  }

  /** Fail-closed: an unknown (company, user) pair reads as `false`. Never the sole security
   *  boundary (plan §D-10 "Correction A") — every write still re-checks role+permission on the
   *  backend; this only decides whether the desktop OFFERS the editor at all. */
  getAuthority(companyUuid: string, userUuid: string): boolean {
    const row = this.database
      .prepare(
        'SELECT can_manage FROM receipt_profile_authority WHERE company_uuid = ? AND user_uuid = ?'
      )
      .get(companyUuid, userUuid) as { can_manage: number } | undefined
    return row?.can_manage === 1
  }

  setAuthority(companyUuid: string, userUuid: string, canManage: boolean, updatedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO receipt_profile_authority (company_uuid, user_uuid, can_manage, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (company_uuid, user_uuid)
         DO UPDATE SET can_manage = excluded.can_manage, updated_at = excluded.updated_at`
      )
      .run(companyUuid, userUuid, canManage ? 1 : 0, updatedAt)
  }

  findPendingAssets(companyUuid: string): readonly { sha256: string }[] {
    return this.database
      .prepare(
        `SELECT sha256 FROM receipt_profile_assets WHERE company_uuid = ? AND status = 'pending'`
      )
      .all(companyUuid) as { sha256: string }[]
  }

  getAsset(companyUuid: string, sha256: string): ReceiptProfileAssetRow | null {
    const row = this.database
      .prepare(
        `SELECT company_uuid AS companyUuid, sha256, media_type AS mediaType, width_px AS widthPx,
                height_px AS heightPx, byte_length AS byteLength, content, status
         FROM receipt_profile_assets WHERE company_uuid = ? AND sha256 = ?`
      )
      .get(companyUuid, sha256) as ReceiptProfileAssetRow | undefined
    return row ?? null
  }

  /**
   * Records an asset this device just uploaded and had the backend hand back, already verified,
   * directly as `available` -- no `pending` placeholder ever existed for it, since no profile
   * version referencing it has been published yet (plan §D-11 admin `choose-logo`). Content-
   * addressed and idempotent: re-choosing the same file in the same session is a safe no-op, and
   * a row already `available` is never touched again (the table's own trigger would reject that).
   */
  recordUploadedAsset(
    companyUuid: string,
    sha256: string,
    mediaType: string,
    widthPx: number,
    heightPx: number,
    byteLength: number,
    content: Buffer,
    now: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO receipt_profile_assets
           (company_uuid, sha256, media_type, width_px, height_px, byte_length, content, status, created_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
         ON CONFLICT (company_uuid, sha256) DO UPDATE SET
           status = 'available', content = excluded.content, fetched_at = excluded.fetched_at
         WHERE receipt_profile_assets.status = 'pending'`
      )
      .run(companyUuid, sha256, mediaType, widthPx, heightPx, byteLength, content, now, now)
  }

  /** `pending -> available`, once (the table's own trigger enforces this too). Returns false when
   *  the row was already available, missing, or did not match (a stale/duplicate fetch). */
  markAssetAvailable(
    companyUuid: string,
    sha256: string,
    content: Buffer,
    fetchedAt: string
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE receipt_profile_assets SET status = 'available', content = ?, fetched_at = ?
         WHERE company_uuid = ? AND sha256 = ? AND status = 'pending'`
      )
      .run(content, fetchedAt, companyUuid, sha256)
    return result.changes > 0
  }

  /** Correction B. Runs in its own transaction; see `ReceiptProfileIngestOutcome` for the exact
   *  rules. `userUuid` is the CURRENT acting user this response belongs to (the bootstrap caller,
   *  or the admin who just published) — `canManage` is recorded ONLY for that one user, never
   *  inferred for anyone else. */
  ingest(
    companyUuid: string,
    userUuid: string | null,
    canManage: boolean | null,
    profile: IncomingReceiptProfileVersion | null,
    now: string
  ): ReceiptProfileIngestOutcome {
    return runSerializedWrite(this.database, () => {
      const existingCurrent = this.database
        .prepare(
          'SELECT version_uuid, capability FROM receipt_profile_current WHERE company_uuid = ?'
        )
        .get(companyUuid) as { version_uuid: string | null; capability: string } | undefined

      if (!existingCurrent) {
        this.database
          .prepare(
            `INSERT INTO receipt_profile_current (company_uuid, version_uuid, capability, updated_at)
             VALUES (?, NULL, 'supported', ?)`
          )
          .run(companyUuid, now)
      } else if (existingCurrent.capability !== 'supported') {
        this.database
          .prepare(
            `UPDATE receipt_profile_current SET capability = 'supported', updated_at = ? WHERE company_uuid = ?`
          )
          .run(now, companyUuid)
      }

      if (userUuid && canManage !== null) {
        this.setAuthority(companyUuid, userUuid, canManage, now)
      }

      if (profile === null) {
        return { kind: 'no_profile' }
      }

      const fieldsJson = fieldsJsonFor(profile)
      const fieldsSha256 = sha256Hex(fieldsJson)

      const existingByRevision = this.database
        .prepare(
          'SELECT version_uuid, fields_sha256 FROM receipt_profile_versions WHERE company_uuid = ? AND revision = ?'
        )
        .get(companyUuid, profile.revision) as
        { version_uuid: string; fields_sha256: string } | undefined

      let versionUuid: string
      let isReplay = false

      if (existingByRevision) {
        if (
          existingByRevision.version_uuid !== profile.versionUuid ||
          existingByRevision.fields_sha256 !== fieldsSha256
        ) {
          return { kind: 'rejected_revision_conflict', revision: profile.revision }
        }
        versionUuid = existingByRevision.version_uuid
        isReplay = true
      } else {
        const existingByUuid = this.database
          .prepare('SELECT 1 FROM receipt_profile_versions WHERE version_uuid = ?')
          .get(profile.versionUuid)
        if (existingByUuid) {
          // A version uuid is globally unique; seeing it under a different revision than the one
          // it was already recorded with would itself be a contract violation. Defensive no-op.
          return { kind: 'rejected_revision_conflict', revision: profile.revision }
        }

        if (profile.logo) {
          this.database
            .prepare(
              `INSERT OR IGNORE INTO receipt_profile_assets
                 (company_uuid, sha256, media_type, width_px, height_px, byte_length, content, status, created_at, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)`
            )
            .run(
              companyUuid,
              profile.logo.sha256,
              profile.logo.mediaType,
              profile.logo.widthPx,
              profile.logo.heightPx,
              profile.logo.byteLength,
              now
            )
        }

        this.database
          .prepare(
            `INSERT INTO receipt_profile_versions
               (version_uuid, company_uuid, revision, fields_json, fields_sha256, logo_sha256, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            profile.versionUuid,
            companyUuid,
            profile.revision,
            fieldsJson,
            fieldsSha256,
            profile.logo?.sha256 ?? null,
            now
          )
        versionUuid = profile.versionUuid
      }

      const pointerRow = this.database
        .prepare('SELECT version_uuid FROM receipt_profile_current WHERE company_uuid = ?')
        .get(companyUuid) as { version_uuid: string | null } | undefined
      const pointerVersionUuid = pointerRow?.version_uuid ?? null

      let pointerMoved = false
      let shouldMovePointer = pointerVersionUuid === null

      if (!shouldMovePointer && pointerVersionUuid !== null) {
        const pointerRevisionRow = this.database
          .prepare('SELECT revision FROM receipt_profile_versions WHERE version_uuid = ?')
          .get(pointerVersionUuid) as { revision: number } | undefined
        shouldMovePointer = (pointerRevisionRow?.revision ?? 0) < profile.revision
      }

      if (shouldMovePointer && pointerVersionUuid !== versionUuid) {
        this.database
          .prepare(
            'UPDATE receipt_profile_current SET version_uuid = ?, updated_at = ? WHERE company_uuid = ?'
          )
          .run(versionUuid, now, companyUuid)
        pointerMoved = true
      }

      return isReplay
        ? { kind: 'idempotent_replay', versionUuid }
        : { kind: 'applied', versionUuid, pointerMoved }
    })
  }
}
