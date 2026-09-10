import type {
  OfflineSaleAuthorityRow,
  StockAuthorizationPolicy
} from '@shared/contracts/sale.contract'
import type { SqliteDatabase } from '../database/connection'

/** The wire shape of a published authority, as the bootstrap contract validates it. */
export interface PublishedOfflineSaleAuthority {
  readonly id: string
  readonly mode: StockAuthorizationPolicy
  readonly policy_revision: number
  readonly contract_version: number
  readonly issued_at: string
  readonly not_before: string
  readonly not_after: string
  readonly authority_hash: string
}

function mapRow(row: Record<string, unknown>): OfflineSaleAuthorityRow {
  return {
    authorityUuid: row.authority_uuid as string,
    companyUuid: row.company_uuid as string,
    deviceUuid: row.device_uuid as string,
    mode: row.mode as StockAuthorizationPolicy,
    policyRevision: row.policy_revision as number,
    contractVersion: row.contract_version as number,
    issuedAt: row.issued_at as string,
    notBefore: row.not_before as string,
    notAfter: row.not_after as string,
    authorityHash: row.authority_hash as string,
    observedAt: row.observed_at as string,
    createdAt: row.created_at as string
  }
}

/**
 * PS4 §6.2/§14.3 — durable storage for server-issued offline-sale authorities.
 *
 * ## The window is stored, never derived
 *
 * `not_after` is written exactly as the server computed it, already clipped to the 72-hour ceiling
 * and to the licence, subscription, grace, catalog and policy boundaries. This repository never
 * recomputes it, never extends it, and never mints a row. Deriving a window locally would mean the
 * client's own clock and plan knowledge decided how long it may sell without a quota, which is the
 * whole thing §6.3a exists to prevent.
 *
 * ## Re-observing is not renewing
 *
 * `observe()` is idempotent on `authority_uuid`. Seeing the same authority again on a later
 * bootstrap updates only `observed_at` — a diagnostic — and leaves the window untouched. §14.3: the
 * window never resets on launch, navigation, a refresh-only cycle, a retry, or a clock rollback.
 * Only a genuinely new authority, minted by a successful server-side validation, brings a new one.
 */
export class OfflineSaleAuthorityRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /**
   * Record a published authority, or refresh only its observation stamp if already known.
   *
   * Returns the stored row so the caller reads back what is actually persisted rather than what it
   * believed it sent.
   */
  observe(
    published: PublishedOfflineSaleAuthority,
    companyUuid: string,
    deviceUuid: string,
    observedAtIso: string
  ): OfflineSaleAuthorityRow {
    const existing = this.findByUuid(published.id)

    if (existing) {
      // Deliberately touches `observed_at` and nothing else. An authority is immutable once issued;
      // if the server ever republished different bytes under the same UUID, silently overwriting
      // them would erase the evidence that the two disagreed.
      this.database
        .prepare('UPDATE offline_sale_authorities SET observed_at = ? WHERE authority_uuid = ?')
        .run(observedAtIso, published.id)

      return this.findByUuid(published.id) as OfflineSaleAuthorityRow
    }

    this.database
      .prepare(
        `INSERT INTO offline_sale_authorities (
           authority_uuid, company_uuid, device_uuid, mode, policy_revision, contract_version,
           issued_at, not_before, not_after, authority_hash, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        published.id,
        companyUuid,
        deviceUuid,
        published.mode,
        published.policy_revision,
        published.contract_version,
        published.issued_at,
        published.not_before,
        published.not_after,
        published.authority_hash,
        observedAtIso,
        observedAtIso
      )

    return this.findByUuid(published.id) as OfflineSaleAuthorityRow
  }

  findByUuid(authorityUuid: string): OfflineSaleAuthorityRow | null {
    const row = this.database
      .prepare('SELECT * FROM offline_sale_authorities WHERE authority_uuid = ?')
      .get(authorityUuid) as Record<string, unknown> | undefined

    return row ? mapRow(row) : null
  }

  /**
   * The authority that currently permits physical-presence selling for this owner, or null.
   *
   * Every term is required and none is inferred:
   *
   *  - owner-scoped to this company AND this device — an authority is bound to a device, so another
   *    workstation's cannot be borrowed;
   *  - `mode = 'physical_presence'` — an `allocation_exclusive` authority permits nothing new;
   *  - `contract_version = 3` — it must license the payload version this build emits;
   *  - the interval is HALF-OPEN, `not_before <= now < not_after`, matching the server's own
   *    acceptance predicate exactly. At precisely `not_after` the authority has expired.
   *
   * Returning null is the ordinary, expected case and is never an error: it simply means this device
   * behaves in legacy mode.
   */
  findUsable(
    companyUuid: string,
    deviceUuid: string,
    nowIso: string
  ): OfflineSaleAuthorityRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM offline_sale_authorities
          WHERE company_uuid = ?
            AND device_uuid = ?
            AND mode = 'physical_presence'
            AND contract_version = 3
            AND not_before <= ?
            AND not_after > ?
          ORDER BY not_after DESC
          LIMIT 1`
      )
      .get(companyUuid, deviceUuid, nowIso, nowIso) as Record<string, unknown> | undefined

    return row ? mapRow(row) : null
  }
}
