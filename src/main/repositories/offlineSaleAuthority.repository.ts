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
  /** Rev 4 §6.3: present only on the negotiated v2 representation. */
  readonly warehouse_uuid?: string
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
    warehouseUuid: (row.warehouse_uuid as string | null) ?? null,
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
    const publishedWarehouse = published.warehouse_uuid ?? null

    if (existing) {
      // An authority is immutable once issued. If the server ever republished different bytes under
      // the same UUID, silently overwriting them would erase the evidence that the two disagreed,
      // so the disagreement is recorded (append-only) and the stored row is left untouched.
      const immutableMatches =
        existing.mode === published.mode &&
        existing.policyRevision === published.policy_revision &&
        existing.contractVersion === published.contract_version &&
        existing.issuedAt === published.issued_at &&
        existing.notBefore === published.not_before &&
        existing.notAfter === published.not_after &&
        existing.authorityHash === published.authority_hash

      if (!immutableMatches) {
        this.recordConflict(published, 'immutable_field_mismatch', observedAtIso)
      } else if (
        publishedWarehouse !== null &&
        existing.warehouseUuid !== null &&
        existing.warehouseUuid !== publishedWarehouse
      ) {
        this.recordConflict(published, 'warehouse_mismatch', observedAtIso)
      } else if (publishedWarehouse !== null && existing.warehouseUuid === null) {
        // Rev 4 §6.4 fill-once: the SERVER now names the warehouse of an authority this device
        // stored before v2 existed — same UUID, same window, same revision, same hash. That is
        // the server's statement, never an inference from this device's current assignment.
        this.database
          .prepare(
            'UPDATE offline_sale_authorities SET warehouse_uuid = ? WHERE authority_uuid = ? AND warehouse_uuid IS NULL'
          )
          .run(publishedWarehouse, published.id)
      }

      // `observed_at` is a diagnostic and never a renewal (§14.3).
      this.database
        .prepare('UPDATE offline_sale_authorities SET observed_at = ? WHERE authority_uuid = ?')
        .run(observedAtIso, published.id)

      return this.findByUuid(published.id) as OfflineSaleAuthorityRow
    }

    this.database
      .prepare(
        `INSERT INTO offline_sale_authorities (
           authority_uuid, company_uuid, device_uuid, mode, policy_revision, contract_version,
           issued_at, not_before, not_after, authority_hash, observed_at, created_at, warehouse_uuid
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        observedAtIso,
        publishedWarehouse
      )

    return this.findByUuid(published.id) as OfflineSaleAuthorityRow
  }

  private recordConflict(
    published: PublishedOfflineSaleAuthority,
    reason: 'immutable_field_mismatch' | 'warehouse_mismatch',
    recordedAtIso: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO offline_sale_authority_conflicts (authority_uuid, reason, published_json, recorded_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(published.id, reason, JSON.stringify(published), recordedAtIso)
  }

  findByUuid(authorityUuid: string): OfflineSaleAuthorityRow | null {
    const row = this.database
      .prepare('SELECT * FROM offline_sale_authorities WHERE authority_uuid = ?')
      .get(authorityUuid) as Record<string, unknown> | undefined

    return row ? mapRow(row) : null
  }

  /**
   * The authority that currently permits physical-presence selling for this owner in THIS warehouse,
   * or null.
   *
   * Every term is required and none is inferred:
   *
   *  - owner-scoped to this company AND this device — an authority is bound to a device, so another
   *    workstation's cannot be borrowed;
   *  - Rev 4 §6.4: issued for `warehouseUuid` (the attempt's origin warehouse) as the SERVER named it.
   *    A row stored before the v2 representation has no warehouse and is never selected;
   *  - `mode = 'physical_presence'` and `contract_version = 3`;
   *  - the interval is HALF-OPEN, `not_before <= at < not_after`, compared as parsed instants (not
   *    strings: `…:00Z` vs `…:00.500Z` must not decide a boundary).
   *
   * Deterministic when several rows qualify: latest `not_after`, then latest `not_before`, then UUID.
   * Which qualifying row is chosen never changes acceptance — the server verifies any row whose
   * window covers `sold_at`.
   */
  findUsable(
    companyUuid: string,
    deviceUuid: string,
    warehouseUuid: string | null,
    at: Date | string
  ): OfflineSaleAuthorityRow | null {
    if (warehouseUuid === null) {
      return null
    }

    const atMs = typeof at === 'string' ? Date.parse(at) : at.getTime()

    if (!Number.isFinite(atMs)) {
      return null
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM offline_sale_authorities
          WHERE company_uuid = ?
            AND device_uuid = ?
            AND warehouse_uuid = ?
            AND mode = 'physical_presence'
            AND contract_version = 3`
      )
      .all(companyUuid, deviceUuid, warehouseUuid) as Record<string, unknown>[]

    const usable = rows
      .map(mapRow)
      .map((row) => ({ row, from: Date.parse(row.notBefore), until: Date.parse(row.notAfter) }))
      .filter(
        ({ from, until }) =>
          Number.isFinite(from) && Number.isFinite(until) && from <= atMs && atMs < until
      )
      .sort(
        (a, b) =>
          b.until - a.until ||
          b.from - a.from ||
          a.row.authorityUuid.localeCompare(b.row.authorityUuid)
      )

    return usable[0]?.row ?? null
  }

  /** The latest stored authority for this warehouse, usable or not (drives renewal scheduling). */
  latestForWarehouse(
    companyUuid: string,
    deviceUuid: string,
    warehouseUuid: string | null
  ): OfflineSaleAuthorityRow | null {
    if (warehouseUuid === null) {
      return null
    }

    const rows = (
      this.database
        .prepare(
          `SELECT * FROM offline_sale_authorities
            WHERE company_uuid = ? AND device_uuid = ? AND warehouse_uuid = ?
              AND mode = 'physical_presence' AND contract_version = 3`
        )
        .all(companyUuid, deviceUuid, warehouseUuid) as Record<string, unknown>[]
    ).map(mapRow)

    return rows.sort((a, b) => Date.parse(b.notAfter) - Date.parse(a.notAfter))[0] ?? null
  }
}
