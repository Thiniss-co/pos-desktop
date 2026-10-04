import type { SqliteDatabase } from '../database/connection'

/**
 * Owner UX plan P9 — the register's copy of the company identity the server delivered.
 *
 * - A block is applied only when its `revision` is greater than the one stored for that company; the
 *   same revision with different content is a protocol error (rejected, left for the next bootstrap).
 * - `logo: null` removes the logo. The register holds one company at a time: applying a block drops every
 *   other company's branding and cached logo bytes.
 * - Logo bytes are stored only after the caller verified them, and dropped once no longer referenced.
 */

export interface IncomingCompanyBranding {
  readonly primaryColor: string | null
  readonly logo: {
    readonly sha256: string
    readonly byteLength: number
    readonly widthPx: number
    readonly heightPx: number
  } | null
  readonly revision: number
}

export type CompanyBrandingApplyOutcome = 'applied' | 'stale' | 'conflict'

export interface StoredCompanyBranding {
  readonly companyUuid: string
  readonly primaryColor: string | null
  readonly logoSha256: string | null
  readonly logo: Buffer | null
  readonly revision: number
}

export interface PendingCompanyLogo {
  readonly sha256: string
  readonly byteLength: number
  readonly widthPx: number
  readonly heightPx: number
}

export const MAX_COMPANY_LOGO_ATTEMPTS = 3

export class CompanyBrandingRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /** Must run inside the bootstrap persist transaction (full path and fast path). */
  applyBlock(
    companyUuid: string,
    incoming: IncomingCompanyBranding,
    receivedAt: string
  ): CompanyBrandingApplyOutcome {
    this.database.prepare('DELETE FROM company_branding WHERE company_uuid <> ?').run(companyUuid)
    this.database
      .prepare('DELETE FROM company_brand_assets WHERE company_uuid <> ?')
      .run(companyUuid)

    const stored = this.database
      .prepare(
        'SELECT primary_color, logo_sha256, revision FROM company_branding WHERE company_uuid = ?'
      )
      .get(companyUuid) as
      { primary_color: string | null; logo_sha256: string | null; revision: number } | undefined
    const color = incoming.primaryColor === null ? null : incoming.primaryColor.toLowerCase()
    const logo = incoming.logo?.sha256 ?? null

    if (stored !== undefined && incoming.revision <= stored.revision) {
      return incoming.revision === stored.revision &&
        (stored.primary_color !== color || stored.logo_sha256 !== logo)
        ? 'conflict'
        : 'stale'
    }

    this.database
      .prepare(
        `INSERT INTO company_branding (company_uuid, primary_color, logo_sha256, revision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (company_uuid) DO UPDATE SET primary_color = excluded.primary_color,
           logo_sha256 = excluded.logo_sha256, revision = excluded.revision, updated_at = excluded.updated_at`
      )
      .run(companyUuid, color, logo, incoming.revision, receivedAt)

    if (incoming.logo) {
      this.database
        .prepare(
          `INSERT INTO company_brand_assets (company_uuid, sha256, width_px, height_px, byte_length, status)
           VALUES (?, ?, ?, ?, ?, 'pending')
           ON CONFLICT (company_uuid, sha256) DO UPDATE SET attempts = CASE WHEN status = 'pending' THEN 0 ELSE attempts END`
        )
        .run(
          companyUuid,
          incoming.logo.sha256,
          incoming.logo.widthPx,
          incoming.logo.heightPx,
          incoming.logo.byteLength
        )
    }
    this.database
      .prepare(
        `DELETE FROM company_brand_assets WHERE company_uuid = ? AND sha256 IS NOT (
           SELECT logo_sha256 FROM company_branding WHERE company_uuid = ?)`
      )
      .run(companyUuid, companyUuid)

    return 'applied'
  }

  current(companyUuid: string): StoredCompanyBranding | null {
    const row = this.database
      .prepare(
        `SELECT b.company_uuid AS companyUuid, b.primary_color AS primaryColor, b.logo_sha256 AS logoSha256,
                b.revision AS revision, a.content AS logo
         FROM company_branding b
         LEFT JOIN company_brand_assets a
           ON a.company_uuid = b.company_uuid AND a.sha256 = b.logo_sha256 AND a.status = 'available'
         WHERE b.company_uuid = ?`
      )
      .get(companyUuid) as StoredCompanyBranding | undefined

    return row ?? null
  }

  findPendingLogo(companyUuid: string): PendingCompanyLogo | null {
    const row = this.database
      .prepare(
        `SELECT a.sha256, a.byte_length AS byteLength, a.width_px AS widthPx, a.height_px AS heightPx
         FROM company_brand_assets a JOIN company_branding b
           ON b.company_uuid = a.company_uuid AND b.logo_sha256 = a.sha256
         WHERE a.company_uuid = ? AND a.status = 'pending' AND a.attempts < ?`
      )
      .get(companyUuid, MAX_COMPANY_LOGO_ATTEMPTS) as PendingCompanyLogo | undefined

    return row ?? null
  }

  markAvailable(companyUuid: string, sha256: string, content: Buffer, fetchedAt: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE company_brand_assets SET status = 'available', content = ?, last_attempt_at = ?
           WHERE company_uuid = ? AND sha256 = ? AND status = 'pending' AND byte_length = ?`
        )
        .run(content, fetchedAt, companyUuid, sha256, content.length).changes > 0
    )
  }

  markFailed(companyUuid: string, sha256: string, attemptedAt: string): void {
    this.database
      .prepare(
        `UPDATE company_brand_assets SET attempts = attempts + 1, last_attempt_at = ?
         WHERE company_uuid = ? AND sha256 = ? AND status = 'pending'`
      )
      .run(attemptedAt, companyUuid, sha256)
  }

  clearAll(): void {
    this.database.prepare('DELETE FROM company_branding').run()
    this.database.prepare('DELETE FROM company_brand_assets').run()
  }
}
