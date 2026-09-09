import type {
  LocalStockAllocationConsumptionRow,
  StockAllocationGrantRow,
  StockAllocationGrantStatus
} from '@shared/contracts/sale.contract'
import type { SqliteDatabase } from '../database/connection'

export interface NewStockAllocationGrant {
  readonly allocationUuid: string
  readonly contractVersion: number
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly productUuid: string
  readonly serverSequence: number
  readonly lifecycleGeneration: number
  readonly grantedQuantityMilli: number
  readonly consumeUntil: string
  readonly envelopeHash: string
  readonly receivedAt: string
}

export interface BootstrapStockAllocationGrant extends NewStockAllocationGrant {
  readonly rightsGeneration: number
  readonly consumedQuantityMilli: number
  readonly remainingQuantityMilli: number
  readonly status: Extract<
    StockAllocationGrantStatus,
    'active' | 'revocation_pending' | 'seal_acknowledged' | 'released' | 'consumed'
  >
  readonly sealNonce: string | null
  readonly finalConsumptionSequence: number | null
  readonly finalConsumptionHash: string | null
  readonly sealedAt: string | null
  readonly acknowledgedAt: string | null
  readonly releasedAt: string | null
}

/**
 * Which response representation established the current snapshot (BH-04B-3).
 *
 * `legacy` means the backend returned no coverage — either it predates the reconciliation
 * representation or this client did not negotiate it. In that mode the pre-BH-04B-3 conservative
 * guard stays in force; absent coverage is never treated as a verified zero boundary.
 */
export type AllocationRepresentation = 'legacy' | 'reconciliation_v2'

export interface AllocationCapability {
  readonly state: 'supported' | 'unavailable'
  readonly revision: number | null
  readonly observedAt: string
  readonly representation: AllocationRepresentation
}

/** The §3.1 coverage boundary exactly as the server publishes it, before any local validation. */
export interface IncomingCoverageBoundary {
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly acceptedConsumptionSequence: number
  readonly acceptedConsumedQuantityMilli: number
  readonly acceptedChainHash: string
}

/** A boundary this device has validated against its own immutable evidence and accepted. */
export interface AcceptedCoverageBoundary extends IncomingCoverageBoundary {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly source: 'bootstrap' | 'top_up' | 'invoice_upload'
  readonly observedAt: string
}

/** The §9.2-4 terminal marker. `id` on the wire is the allocation uuid. */
export interface IncomingTerminalMarker {
  readonly allocationUuid: string
  readonly status: 'released' | 'consumed'
  readonly lifecycleGeneration: number
  readonly terminalRevision: number
}

export interface StockAllocationTerminalMarkerRow extends IncomingTerminalMarker {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly observedAt: string
}

export type StockAllocationHoldReason =
  'unreconstructable_prefix' | 'coverage_conflict' | 'coverage_inconsistent' | 'terminal_conflict'

export interface StockAllocationHoldRow {
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly reason: StockAllocationHoldReason
  readonly detail: string | null
  readonly createdAt: string
}

interface BootstrapIngestionContext {
  readonly revision: number
  readonly observedAt: string
}

export interface NewLocalStockAllocationConsumption {
  readonly localUuid: string
  readonly allocationUuid: string
  readonly consumptionSequence: number
  readonly invoiceLocalUuid: string
  readonly itemLocalUuid: string
  readonly quantityMilli: number
  readonly createdAt: string
  /**
   * BH-04B-3: journal-v1 evidence, pinned at commit. `rightsGeneration` is recorded here rather than
   * being read back from the grant at upload time, so a bootstrap arriving in between can never
   * change the identity this consumption was authored against.
   */
  readonly rightsGeneration: number
  readonly invoiceIdempotencyKey: string
  readonly itemLineUuid: string
  readonly requestHash: string
  readonly entryHash: string
  readonly chainHash: string
}

function legacyStatus(row: Record<string, unknown>): StockAllocationGrantStatus {
  switch (row.status) {
    case 'sealed':
      return 'legacy-sealed'
    case 'expired':
      return 'legacy-expired'
    case 'active':
    case 'consumed':
    case 'released':
      return row.status
    default:
      throw new Error('The stored allocation grant has an unsupported legacy status')
  }
}

function mapGrantRow(row: Record<string, unknown>): StockAllocationGrantRow {
  return {
    allocationUuid: row.allocation_uuid as string,
    contractVersion: row.contract_version as number,
    companyUuid: row.company_uuid as string,
    deviceUuid: row.device_uuid as string,
    warehouseUuid: row.warehouse_uuid as string,
    productUuid: row.product_uuid as string,
    serverSequence: row.server_sequence as number,
    rightsGeneration: row.rights_generation as number,
    lifecycleGeneration: row.lifecycle_generation as number,
    grantedQuantityMilli: row.granted_quantity_milli as number,
    serverConsumedQuantityMilli: row.server_consumed_quantity_milli as number,
    serverRemainingQuantityMilli: row.server_remaining_quantity_milli as number,
    consumeUntil: row.consume_until as string,
    status: (row.server_status as StockAllocationGrantStatus | null) ?? legacyStatus(row),
    envelopeHash: row.envelope_hash as string,
    sealNonce: row.seal_nonce as string | null,
    finalConsumptionSequence: row.final_consumption_sequence as number | null,
    finalConsumptionHash: row.final_consumption_hash as string | null,
    receivedAt: row.received_at as string,
    sealedAt: row.sealed_at as string | null,
    acknowledgedAt: row.acknowledged_at as string | null,
    releasedAt: row.released_at as string | null,
    lastObservedRevision: row.last_observed_revision as number | null,
    updatedAt: row.updated_at as string
  }
}

function mapConsumptionRow(row: Record<string, unknown>): LocalStockAllocationConsumptionRow {
  return {
    localUuid: row.local_uuid as string,
    allocationUuid: row.allocation_uuid as string,
    consumptionSequence: row.consumption_sequence as number,
    invoiceLocalUuid: row.invoice_local_uuid as string,
    itemLocalUuid: row.item_local_uuid as string,
    quantityMilli: row.quantity_milli as number,
    serverStatus: row.server_status as LocalStockAllocationConsumptionRow['serverStatus'],
    serverConsumptionUuid: row.server_consumption_uuid as string | null,
    acknowledgedAt: row.acknowledged_at as string | null,
    createdAt: row.created_at as string,
    rightsGeneration: (row.rights_generation as number | null) ?? null,
    invoiceIdempotencyKey: (row.invoice_idempotency_key as string | null) ?? null,
    itemLineUuid: (row.item_line_uuid as string | null) ?? null,
    requestHash: (row.request_hash as string | null) ?? null,
    entryHash: (row.entry_hash as string | null) ?? null,
    chainHash: (row.chain_hash as string | null) ?? null
  }
}

/**
 * BH-04B-3: the legacy `status` mirror for an authoritative backend lifecycle value. Migration 0009
 * constrains the two columns to agree, so every writer must go through this one mapping.
 */
export function legacyStatusFor(serverStatus: BootstrapStockAllocationGrant['status']): string {
  switch (serverStatus) {
    case 'revocation_pending':
    case 'seal_acknowledged':
      return 'sealed'
    default:
      return serverStatus
  }
}

function sameBootstrapIdentity(
  existing: StockAllocationGrantRow,
  incoming: BootstrapStockAllocationGrant
): boolean {
  return (
    existing.companyUuid === incoming.companyUuid &&
    existing.deviceUuid === incoming.deviceUuid &&
    existing.warehouseUuid === incoming.warehouseUuid &&
    existing.productUuid === incoming.productUuid &&
    existing.contractVersion === incoming.contractVersion &&
    existing.serverSequence === incoming.serverSequence
  )
}

function sameBootstrapEnvelope(
  existing: StockAllocationGrantRow,
  incoming: BootstrapStockAllocationGrant
): boolean {
  return (
    sameBootstrapIdentity(existing, incoming) &&
    existing.rightsGeneration === incoming.rightsGeneration &&
    existing.lifecycleGeneration === incoming.lifecycleGeneration &&
    existing.grantedQuantityMilli === incoming.grantedQuantityMilli &&
    existing.serverConsumedQuantityMilli === incoming.consumedQuantityMilli &&
    existing.serverRemainingQuantityMilli === incoming.remainingQuantityMilli &&
    existing.consumeUntil === incoming.consumeUntil &&
    existing.status === incoming.status &&
    existing.envelopeHash === incoming.envelopeHash &&
    existing.sealNonce === incoming.sealNonce &&
    existing.finalConsumptionSequence === incoming.finalConsumptionSequence &&
    existing.finalConsumptionHash === incoming.finalConsumptionHash &&
    existing.sealedAt === incoming.sealedAt &&
    existing.acknowledgedAt === incoming.acknowledgedAt &&
    existing.releasedAt === incoming.releasedAt
  )
}

/**
 * Main-process persistence for server-created allocation envelopes. Bootstrap writes it inside the
 * same SQLite transaction as the catalog. Omitted grants are intentionally retained for audit, but
 * become unusable because `lastObservedRevision` no longer matches the current full snapshot.
 */
export class StockAllocationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getCapability(): AllocationCapability | null {
    const row = this.database
      .prepare(
        'SELECT state, revision, observed_at, representation FROM bootstrap_allocation_capability WHERE id = 1'
      )
      .get() as
      | {
          readonly state: AllocationCapability['state']
          readonly revision: number | null
          readonly observed_at: string
          readonly representation: AllocationRepresentation
        }
      | undefined

    return row
      ? {
          state: row.state,
          revision: row.revision,
          observedAt: row.observed_at,
          representation: row.representation
        }
      : null
  }

  /**
   * Records an older backend explicitly; retained grants cannot act as current authority. The
   * representation drops back to `legacy`, because a backend that publishes no allocation capability
   * publishes no coverage either — and an absent boundary must never read as a verified one.
   */
  markCapabilityUnavailable(observedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO bootstrap_allocation_capability (id, state, revision, observed_at, representation)
         VALUES (1, 'unavailable', NULL, ?, 'legacy')
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           revision = excluded.revision,
           observed_at = excluded.observed_at,
           representation = excluded.representation`
      )
      .run(observedAt)
  }

  /**
   * Applies one complete, validated backend snapshot. Callers must already be in the catalog
   * transaction. Equal revisions are idempotent; a rollback or a grant lifecycle rollback is a
   * contract failure, never a silent downgrade.
   */
  ingestBootstrapSnapshot(
    revision: number,
    grants: readonly BootstrapStockAllocationGrant[],
    observedAt: string,
    representation: AllocationRepresentation = 'legacy'
  ): void {
    const capability = this.getCapability()
    if (
      capability?.state === 'supported' &&
      capability.revision !== null &&
      revision < capability.revision
    ) {
      throw new Error('The allocation revision is older than the active local allocation snapshot')
    }

    const allocationUuids = new Set<string>()
    for (const grant of grants) {
      if (allocationUuids.has(grant.allocationUuid)) {
        throw new Error('The allocation snapshot contains a duplicate allocation UUID')
      }
      allocationUuids.add(grant.allocationUuid)
    }

    if (capability?.state === 'supported' && capability.revision === revision) {
      const current = this.grantsObservedAt(revision)
      const identical =
        current.length === grants.length &&
        grants.every((grant) => {
          const existing = current.find((row) => row.allocationUuid === grant.allocationUuid)
          return existing ? sameBootstrapEnvelope(existing, grant) : false
        })

      if (!identical) {
        throw new Error(
          'The allocation revision conflicts with the active local allocation snapshot'
        )
      }

      // An identical re-apply is a no-op for the grants, but the representation still records how
      // this snapshot was obtained: a client that has just upgraded to the reconciliation
      // representation must not stay pinned to the conservative legacy mode until the revision moves.
      this.writeCapability(revision, observedAt, representation)

      return
    }

    for (const grant of grants) {
      const existing = this.findGrantByUuid(grant.allocationUuid)
      if (existing) {
        if (!sameBootstrapIdentity(existing, grant)) {
          throw new Error('The allocation snapshot changes an immutable grant identity')
        }
        if (grant.lifecycleGeneration < existing.lifecycleGeneration) {
          throw new Error('The allocation snapshot rolls back a grant lifecycle generation')
        }
      }

      this.upsertGrant(grant, { revision, observedAt })
    }

    this.writeCapability(revision, observedAt, representation)
  }

  private writeCapability(
    revision: number,
    observedAt: string,
    representation: AllocationRepresentation
  ): void {
    this.database
      .prepare(
        `INSERT INTO bootstrap_allocation_capability (id, state, revision, observed_at, representation)
         VALUES (1, 'supported', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           revision = excluded.revision,
           observed_at = excluded.observed_at,
           representation = excluded.representation`
      )
      .run(revision, observedAt, representation)
  }

  /**
   * CP-5D-E: applies the grants returned by `POST /stock-allocations/top-up` (already validated
   * against the exact owner/product demand by `AllocationAcquisitionService`). Callers must wrap
   * this in one `database.transaction()`; it performs no HTTP and holds no transaction itself.
   *
   * A top-up response is an **incremental** grant issue, not a snapshot: it names only the grants
   * this request created (or replayed) and says nothing about the grants the device already holds.
   * It therefore joins the *current* bootstrap snapshot (`last_observed_revision` = the active
   * capability revision) and deliberately does **not** advance the capability revision. Advancing it
   * here would mark every previously bootstrapped grant as omitted-from-the-current-snapshot and
   * silently strip its sale authority, which is precisely the failure mode `usableGrantsForProduct`
   * exists to prevent. The next full bootstrap names the new grant and moves the revision normally.
   *
   * Replaying the identical server grant is idempotent. The same immutable grant identity arriving
   * with different content is a contract failure and rolls the caller's transaction back — it is
   * never resolved by taking the newer or the larger value.
   */
  ingestTopUpGrants(grants: readonly BootstrapStockAllocationGrant[], observedAt: string): void {
    const capability = this.getCapability()

    if (capability?.state !== 'supported' || capability.revision === null) {
      throw new Error('A stock allocation top-up requires an active bootstrap allocation snapshot')
    }

    const allocationUuids = new Set<string>()
    for (const grant of grants) {
      if (allocationUuids.has(grant.allocationUuid)) {
        throw new Error('The allocation top-up response contains a duplicate allocation UUID')
      }
      allocationUuids.add(grant.allocationUuid)
    }

    for (const grant of grants) {
      const existing = this.findGrantByUuid(grant.allocationUuid)

      if (existing) {
        if (!sameBootstrapIdentity(existing, grant)) {
          throw new Error('The allocation top-up changes an immutable grant identity')
        }
        if (grant.lifecycleGeneration < existing.lifecycleGeneration) {
          throw new Error('The allocation top-up rolls back a grant lifecycle generation')
        }
        if (!sameBootstrapEnvelope(existing, grant)) {
          throw new Error('The allocation top-up conflicts with the stored grant envelope')
        }
      }

      this.writeBootstrapGrant(grant, capability.revision, observedAt)
    }
  }

  /**
   * CP-5D-G sanitized diagnostics only. Counts are reported so a support session can tell an empty
   * allocation set apart from an unusable one; they carry no authority, name no grant, and are never
   * consulted by completion, which always re-resolves `usableGrantsForProduct` per product.
   */
  diagnostics(nowIso: string): {
    readonly present: boolean
    readonly revision: number | null
    readonly total: number
    readonly usable: number
  } {
    const capability = this.getCapability()
    const currentRevision = capability?.state === 'supported' ? capability.revision : null
    const total = (
      this.database.prepare('SELECT COUNT(*) AS total FROM stock_allocation_grants').get() as {
        total: number
      }
    ).total
    const usable =
      capability?.state === 'unavailable'
        ? 0
        : (
            this.database
              .prepare(
                `SELECT COUNT(*) AS total FROM stock_allocation_grants
                   WHERE COALESCE(server_status, status) = 'active'
                     AND consume_until > ?
                     AND server_consumed_quantity_milli = 0
                     AND (? IS NULL OR last_observed_revision = ?)`
              )
              .get(nowIso, currentRevision, currentRevision) as { total: number }
          ).total

    return {
      present: capability?.state === 'supported',
      revision: currentRevision,
      total,
      usable
    }
  }

  /**
   * Persists a validated server envelope during bootstrap. The one-argument form remains solely
   * for controlled local setup in tests and intentionally creates no backend authority itself.
   */
  upsertGrant(
    grant: BootstrapStockAllocationGrant,
    context: BootstrapIngestionContext
  ): StockAllocationGrantRow
  upsertGrant(grant: NewStockAllocationGrant): StockAllocationGrantRow
  upsertGrant(
    grant: BootstrapStockAllocationGrant | NewStockAllocationGrant,
    context?: BootstrapIngestionContext
  ): StockAllocationGrantRow {
    if (context) {
      this.writeBootstrapGrant(
        grant as BootstrapStockAllocationGrant,
        context.revision,
        context.observedAt
      )
      const persisted = this.findGrantByUuid(grant.allocationUuid)
      if (!persisted) {
        throw new Error('Bootstrap stock allocation grant did not persist')
      }
      return persisted
    }

    const existing = this.findGrantByUuid(grant.allocationUuid)
    if (existing) {
      return existing
    }

    const capability = this.getCapability()
    const currentRevision = capability?.state === 'supported' ? capability.revision : null

    this.database
      .prepare(
        `INSERT INTO stock_allocation_grants (
           allocation_uuid, contract_version, company_uuid, device_uuid, warehouse_uuid,
           product_uuid, server_sequence, rights_generation, lifecycle_generation,
           granted_quantity_milli, server_consumed_quantity_milli, server_remaining_quantity_milli,
           consume_until, status, server_status, envelope_hash, received_at, last_observed_revision,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, 'active', NULL, ?, ?, ?, ?)`
      )
      .run(
        grant.allocationUuid,
        grant.contractVersion,
        grant.companyUuid,
        grant.deviceUuid,
        grant.warehouseUuid,
        grant.productUuid,
        grant.serverSequence,
        grant.lifecycleGeneration,
        grant.grantedQuantityMilli,
        grant.grantedQuantityMilli,
        grant.consumeUntil,
        grant.envelopeHash,
        grant.receivedAt,
        currentRevision,
        grant.receivedAt
      )

    const created = this.findGrantByUuid(grant.allocationUuid)
    if (!created) {
      throw new Error('Stock allocation grant did not persist')
    }
    return created
  }

  findGrantByUuid(allocationUuid: string): StockAllocationGrantRow | null {
    const row = this.database
      .prepare('SELECT * FROM stock_allocation_grants WHERE allocation_uuid = ?')
      .get(allocationUuid) as Record<string, unknown> | undefined
    return row ? mapGrantRow(row) : null
  }

  /**
   * Only current, server-active, owner-matching, unexpired grants can be consumed.
   *
   * Every gate that existed before BH-04B-3 is unchanged — exact owner tuple and product, live
   * `server_status`, `consume_until`, and `last_observed_revision` equality with the current
   * snapshot. Three things are added:
   *
   * - A grant with a terminal marker is never usable, even if a stale envelope still lists it as
   *   active. Terminal state is permanent for that allocation identity.
   * - A grant under a durable hold is never usable. A hold is written whenever observed evidence is
   *   missing, inconsistent or impossible, and is only cleared by reconciliation that actually
   *   establishes the boundary.
   * - Spendability itself now depends on the representation. Under `reconciliation_v2` the §3.1
   *   boundary replaces the conservative guard, and a grant with no accepted boundary is **not**
   *   usable — absent coverage fails closed rather than defaulting to a verified zero. Under
   *   `legacy` the original `server_consumed_quantity_milli = 0` guard stays exactly as it was.
   */
  usableGrantsForProduct(
    owner: {
      readonly companyUuid: string
      readonly deviceUuid: string
      readonly warehouseUuid: string
    },
    productUuid: string,
    nowIso: string
  ): readonly StockAllocationGrantRow[] {
    const capability = this.getCapability()
    if (capability?.state === 'unavailable') {
      return []
    }

    const currentRevision = capability?.state === 'supported' ? capability.revision : null
    const reconciled = capability?.representation === 'reconciliation_v2' ? 1 : 0

    return (
      this.database
        .prepare(
          `SELECT g.* FROM stock_allocation_grants g
             WHERE g.company_uuid = ? AND g.device_uuid = ? AND g.warehouse_uuid = ?
               AND g.product_uuid = ?
               AND COALESCE(g.server_status, g.status) = 'active'
               AND g.consume_until > ?
               AND (? IS NULL OR g.last_observed_revision = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM stock_allocation_terminal_markers m
                  WHERE m.allocation_uuid = g.allocation_uuid
               )
               AND NOT EXISTS (
                 SELECT 1 FROM stock_allocation_holds h
                  WHERE h.allocation_uuid = g.allocation_uuid
                    AND h.rights_generation = g.rights_generation
               )
               AND NOT EXISTS (
                 SELECT 1 FROM stock_allocation_recoveries r
                  WHERE r.allocation_uuid = g.allocation_uuid
                    AND r.rights_generation = g.rights_generation
               )
               AND CASE WHEN ? = 1
                 THEN EXISTS (
                   SELECT 1 FROM stock_allocation_coverage_boundaries b
                    WHERE b.allocation_uuid = g.allocation_uuid
                      AND b.rights_generation = g.rights_generation
                      AND b.company_uuid = g.company_uuid
                      AND b.device_uuid = g.device_uuid
                 )
                 ELSE g.server_consumed_quantity_milli = 0
               END
             ORDER BY g.consume_until ASC, g.server_sequence ASC, g.allocation_uuid ASC`
        )
        .all(
          owner.companyUuid,
          owner.deviceUuid,
          owner.warehouseUuid,
          productUuid,
          nowIso,
          currentRevision,
          currentRevision,
          reconciled
        ) as Record<string, unknown>[]
    ).map(mapGrantRow)
  }

  /**
   * How much of this grant this device may still spend.
   *
   * Under the reconciliation representation this is the exact BH-04A §3.1 formula:
   *
   * ```text
   * spendable = granted_quantity_milli
   *           - accepted_consumed_quantity_milli            // covered by the boundary
   *           - SUM(local committed quantity_milli where consumption_sequence > accepted sequence)
   * ```
   *
   * Acknowledgement status never enters this arithmetic — both `pending` and `acknowledged` local
   * rows above the boundary sequence are deducted, which is precisely what makes both arrival orders
   * converge instead of double-subtracting or resurrecting spent rights. A grant with no accepted
   * boundary, a terminal marker, or a durable hold is not spendable at all; the result is never
   * clamped up from an impossible value into a plausible one.
   *
   * Under the legacy representation the original behavior is preserved byte-for-byte, because a
   * backend that publishes no boundary gives this client nothing to verify.
   */
  /**
   * CP4/§5.2: the candidate product set for a preparation cycle, resolved by **main**.
   *
   * The honest candidate set is the tracked products this device already holds allocation evidence
   * for, in this warehouse. That is deliberately narrower than "every catalog product": the desktop
   * has no policy-visibility contract, so naming products the server has no policy for would ask it
   * to evaluate scopes this device has no business naming, and would turn an ordinary configuration
   * gap into a refused operation.
   *
   * Released and consumed grants are included as *candidates* — a product whose grant is spent is
   * exactly the one preparation exists to top up. Spendability is a different question, answered by
   * `usableGrantsForProduct`.
   *
   * A renderer list never reaches this method, and never could: it takes only an owner tuple.
   */
  preparableProductUuids(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly warehouseUuid: string
  }): readonly string[] {
    return this.database
      .prepare<[string, string, string], { product_uuid: string }>(
        `SELECT DISTINCT product_uuid FROM stock_allocation_grants
          WHERE company_uuid = ? AND device_uuid = ? AND warehouse_uuid = ?
          ORDER BY product_uuid`
      )
      .all(owner.companyUuid, owner.deviceUuid, owner.warehouseUuid)
      .map((row) => row.product_uuid)
  }

  spendableMilli(allocationUuid: string): number {
    const grant = this.findGrantByUuid(allocationUuid)
    if (!grant) {
      return 0
    }

    if (this.findTerminalMarker(allocationUuid) !== null) {
      return 0
    }
    if (this.findHold(allocationUuid, grant.rightsGeneration) !== null) {
      return 0
    }
    if (this.hasRecovery(allocationUuid, grant.rightsGeneration)) {
      return 0
    }

    const capability = this.getCapability()

    if (capability?.representation !== 'reconciliation_v2') {
      const pending = this.database
        .prepare(
          `SELECT COALESCE(SUM(quantity_milli), 0) AS total
             FROM local_stock_allocation_consumptions
            WHERE allocation_uuid = ? AND server_status = 'pending'`
        )
        .get(allocationUuid) as { total: number }
      const serverRemaining =
        grant.lastObservedRevision === null
          ? grant.grantedQuantityMilli
          : grant.serverRemainingQuantityMilli

      return Math.max(0, serverRemaining - pending.total)
    }

    const boundary = this.findCoverageBoundary(allocationUuid, grant.rightsGeneration)

    if (boundary === null) {
      return 0
    }

    const uncovered = this.committedQuantityAboveSequence(
      allocationUuid,
      grant.rightsGeneration,
      boundary.acceptedConsumptionSequence
    )
    const spendable =
      grant.grantedQuantityMilli - boundary.acceptedConsumedQuantityMilli - uncovered

    // An impossible balance means the evidence disagrees with itself. Denying the spend is the only
    // safe reading; clamping it to zero silently would hide the inconsistency from reconciliation.
    if (!Number.isSafeInteger(spendable) || spendable < 0) {
      return 0
    }

    return spendable
  }

  /**
   * Every local committed consumption above the boundary sequence, for this exact grant identity.
   * Rows authored before migration 0009 have no `rights_generation`, so they are matched by the
   * grant's own generation to keep historical evidence in the sum rather than silently dropping it.
   */
  committedQuantityAboveSequence(
    allocationUuid: string,
    rightsGeneration: number,
    sequence: number
  ): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(quantity_milli), 0) AS total
           FROM local_stock_allocation_consumptions
          WHERE allocation_uuid = ?
            AND COALESCE(rights_generation, ?) = ?
            AND consumption_sequence > ?`
      )
      .get(allocationUuid, rightsGeneration, rightsGeneration, sequence) as { total: number }

    return row.total
  }

  /** The local journal rows for one grant identity, in sequence order. */
  journalEntriesFor(
    allocationUuid: string,
    rightsGeneration: number
  ): readonly LocalStockAllocationConsumptionRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM local_stock_allocation_consumptions
            WHERE allocation_uuid = ? AND COALESCE(rights_generation, ?) = ?
            ORDER BY consumption_sequence ASC`
        )
        .all(allocationUuid, rightsGeneration, rightsGeneration) as Record<string, unknown>[]
    ).map(mapConsumptionRow)
  }

  /**
   * The chain hash the next consumption for this grant identity must extend, or `null` when the
   * journal is empty and the caller should start from the journal-v1 initial hash.
   *
   * Throws when the newest row has no stored chain hash: that row's evidence could not be
   * reconstructed, so there is no chain to extend. Continuing from the initial hash, or from an
   * older row, would fabricate a journal — the caller must fail closed instead.
   */
  latestJournalChainHash(allocationUuid: string, rightsGeneration: number): string | null {
    const row = this.database
      .prepare(
        `SELECT consumption_sequence, chain_hash
           FROM local_stock_allocation_consumptions
          WHERE allocation_uuid = ? AND COALESCE(rights_generation, ?) = ?
          ORDER BY consumption_sequence DESC
          LIMIT 1`
      )
      .get(allocationUuid, rightsGeneration, rightsGeneration) as
      { readonly consumption_sequence: number; readonly chain_hash: string | null } | undefined

    if (row === undefined) {
      return null
    }

    if (row.chain_hash === null) {
      throw new Error(
        'The local allocation journal has no reconstructable chain hash at its newest sequence'
      )
    }

    return row.chain_hash
  }

  findCoverageBoundary(
    allocationUuid: string,
    rightsGeneration: number
  ): AcceptedCoverageBoundary | null {
    const row = this.database
      .prepare(
        `SELECT * FROM stock_allocation_coverage_boundaries
          WHERE allocation_uuid = ? AND rights_generation = ?`
      )
      .get(allocationUuid, rightsGeneration) as Record<string, unknown> | undefined

    return row
      ? {
          allocationUuid: row.allocation_uuid as string,
          rightsGeneration: row.rights_generation as number,
          companyUuid: row.company_uuid as string,
          deviceUuid: row.device_uuid as string,
          acceptedConsumptionSequence: row.accepted_consumption_sequence as number,
          acceptedConsumedQuantityMilli: row.accepted_consumed_quantity_milli as number,
          acceptedChainHash: row.accepted_chain_hash as string,
          source: row.source as AcceptedCoverageBoundary['source'],
          observedAt: row.observed_at as string
        }
      : null
  }

  /**
   * Stores an already-validated boundary. Monotonicity is enforced here as well as in the validator,
   * so no path can lower a stored sequence: the `WHERE excluded.accepted_consumption_sequence >`
   * clause makes an older boundary a silent no-op rather than a regression.
   */
  writeCoverageBoundary(boundary: AcceptedCoverageBoundary): void {
    this.database
      .prepare(
        `INSERT INTO stock_allocation_coverage_boundaries (
           allocation_uuid, rights_generation, company_uuid, device_uuid,
           accepted_consumption_sequence, accepted_consumed_quantity_milli, accepted_chain_hash,
           source, observed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid, rights_generation) DO UPDATE SET
           accepted_consumption_sequence = excluded.accepted_consumption_sequence,
           accepted_consumed_quantity_milli = excluded.accepted_consumed_quantity_milli,
           accepted_chain_hash = excluded.accepted_chain_hash,
           source = excluded.source,
           observed_at = excluded.observed_at,
           updated_at = excluded.updated_at
         WHERE excluded.accepted_consumption_sequence
               > stock_allocation_coverage_boundaries.accepted_consumption_sequence`
      )
      .run(
        boundary.allocationUuid,
        boundary.rightsGeneration,
        boundary.companyUuid,
        boundary.deviceUuid,
        boundary.acceptedConsumptionSequence,
        boundary.acceptedConsumedQuantityMilli,
        boundary.acceptedChainHash,
        boundary.source,
        boundary.observedAt,
        boundary.observedAt
      )
  }

  findTerminalMarker(allocationUuid: string): StockAllocationTerminalMarkerRow | null {
    const row = this.database
      .prepare('SELECT * FROM stock_allocation_terminal_markers WHERE allocation_uuid = ?')
      .get(allocationUuid) as Record<string, unknown> | undefined

    return row
      ? {
          allocationUuid: row.allocation_uuid as string,
          companyUuid: row.company_uuid as string,
          deviceUuid: row.device_uuid as string,
          status: row.status as StockAllocationTerminalMarkerRow['status'],
          lifecycleGeneration: row.lifecycle_generation as number,
          terminalRevision: row.terminal_revision as number,
          observedAt: row.observed_at as string
        }
      : null
  }

  /**
   * Terminal state is permanent for an allocation identity, so this only ever moves forward: an
   * update lands solely when both the lifecycle generation and the terminal revision are
   * non-regressing. An older marker, or a re-delivery of the same one, changes nothing.
   */
  writeTerminalMarker(marker: StockAllocationTerminalMarkerRow): void {
    this.database
      .prepare(
        `INSERT INTO stock_allocation_terminal_markers (
           allocation_uuid, company_uuid, device_uuid, status, lifecycle_generation,
           terminal_revision, observed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid) DO UPDATE SET
           status = excluded.status,
           lifecycle_generation = excluded.lifecycle_generation,
           terminal_revision = excluded.terminal_revision,
           observed_at = excluded.observed_at,
           updated_at = excluded.updated_at
         WHERE excluded.lifecycle_generation
                 >= stock_allocation_terminal_markers.lifecycle_generation
           AND excluded.terminal_revision >= stock_allocation_terminal_markers.terminal_revision`
      )
      .run(
        marker.allocationUuid,
        marker.companyUuid,
        marker.deviceUuid,
        marker.status,
        marker.lifecycleGeneration,
        marker.terminalRevision,
        marker.observedAt,
        marker.observedAt
      )
  }

  findHold(allocationUuid: string, rightsGeneration: number): StockAllocationHoldRow | null {
    const row = this.database
      .prepare(
        'SELECT * FROM stock_allocation_holds WHERE allocation_uuid = ? AND rights_generation = ?'
      )
      .get(allocationUuid, rightsGeneration) as Record<string, unknown> | undefined

    return row
      ? {
          allocationUuid: row.allocation_uuid as string,
          rightsGeneration: row.rights_generation as number,
          reason: row.reason as StockAllocationHoldReason,
          detail: row.detail as string | null,
          createdAt: row.created_at as string
        }
      : null
  }

  hasRecovery(allocationUuid: string, rightsGeneration: number): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM stock_allocation_recoveries
            WHERE allocation_uuid = ? AND rights_generation = ?`
        )
        .get(allocationUuid, rightsGeneration) !== undefined
    )
  }

  observeRecoveryLifecycle(input: {
    readonly allocationUuid: string
    readonly rightsGeneration: number
    readonly lifecycleGeneration: number
    readonly status: 'revocation_pending' | 'seal_acknowledged' | 'released' | 'consumed'
    readonly sealNonce: string | null
    readonly finalConsumptionSequence: number | null
    readonly finalConsumptionHash: string | null
    readonly sealedAt: string | null
    readonly acknowledgedAt: string | null
    readonly releasedAt: string | null
    readonly updatedAt: string
  }): void {
    const legacyStatus =
      input.status === 'revocation_pending' || input.status === 'seal_acknowledged'
        ? 'sealed'
        : input.status
    const result = this.database
      .prepare(
        `UPDATE stock_allocation_grants
            SET lifecycle_generation = ?, server_status = ?, status = ?, seal_nonce = ?,
                final_consumption_sequence = ?, final_consumption_hash = ?, sealed_at = ?,
                acknowledged_at = ?, released_at = ?, updated_at = ?
          WHERE allocation_uuid = ? AND rights_generation = ?
            AND lifecycle_generation <= ?`
      )
      .run(
        input.lifecycleGeneration,
        input.status,
        legacyStatus,
        input.sealNonce,
        input.finalConsumptionSequence,
        input.finalConsumptionHash,
        input.sealedAt,
        input.acknowledgedAt,
        input.releasedAt,
        input.updatedAt,
        input.allocationUuid,
        input.rightsGeneration,
        input.lifecycleGeneration
      )

    if (result.changes !== 1) {
      throw new Error('The recovery lifecycle response is stale or does not match the local grant')
    }
  }

  /** Durable deny-spend state. The first reason recorded wins; a later one never overwrites it. */
  recordHold(
    allocationUuid: string,
    rightsGeneration: number,
    reason: StockAllocationHoldReason,
    detail: string | null,
    createdAt: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO stock_allocation_holds (allocation_uuid, rights_generation, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid, rights_generation) DO NOTHING`
      )
      .run(allocationUuid, rightsGeneration, reason, detail, createdAt)
  }

  /**
   * Clears a hold. Only reconciliation that has actually re-established a valid boundary may call
   * this — never a fallback, a retry, or an error handler.
   */
  clearHold(allocationUuid: string, rightsGeneration: number): void {
    this.database
      .prepare(
        'DELETE FROM stock_allocation_holds WHERE allocation_uuid = ? AND rights_generation = ?'
      )
      .run(allocationUuid, rightsGeneration)
  }

  insertConsumption(
    consumption: NewLocalStockAllocationConsumption
  ): LocalStockAllocationConsumptionRow {
    this.database
      .prepare(
        `INSERT INTO local_stock_allocation_consumptions (
           local_uuid, allocation_uuid, consumption_sequence, invoice_local_uuid, item_local_uuid,
           quantity_milli, server_status, created_at, rights_generation, invoice_idempotency_key,
           item_line_uuid, request_hash, entry_hash, chain_hash
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        consumption.localUuid,
        consumption.allocationUuid,
        consumption.consumptionSequence,
        consumption.invoiceLocalUuid,
        consumption.itemLocalUuid,
        consumption.quantityMilli,
        consumption.createdAt,
        consumption.rightsGeneration,
        consumption.invoiceIdempotencyKey,
        consumption.itemLineUuid,
        consumption.requestHash,
        consumption.entryHash,
        consumption.chainHash
      )

    const row = this.database
      .prepare('SELECT * FROM local_stock_allocation_consumptions WHERE local_uuid = ?')
      .get(consumption.localUuid) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error('Local stock allocation consumption did not persist')
    }
    return mapConsumptionRow(row)
  }

  consumptionsForInvoice(invoiceLocalUuid: string): readonly LocalStockAllocationConsumptionRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM local_stock_allocation_consumptions
             WHERE invoice_local_uuid = ?
             ORDER BY item_local_uuid ASC, consumption_sequence ASC, allocation_uuid ASC`
        )
        .all(invoiceLocalUuid) as Record<string, unknown>[]
    ).map(mapConsumptionRow)
  }

  nextConsumptionSequence(allocationUuid: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(consumption_sequence), 0) AS maxSequence FROM local_stock_allocation_consumptions WHERE allocation_uuid = ?'
      )
      .get(allocationUuid) as { maxSequence: number }
    return row.maxSequence + 1
  }

  private grantsObservedAt(revision: number): readonly StockAllocationGrantRow[] {
    return (
      this.database
        .prepare('SELECT * FROM stock_allocation_grants WHERE last_observed_revision = ?')
        .all(revision) as Record<string, unknown>[]
    ).map(mapGrantRow)
  }

  private writeBootstrapGrant(
    grant: BootstrapStockAllocationGrant,
    revision: number,
    observedAt: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO stock_allocation_grants (
           allocation_uuid, contract_version, company_uuid, device_uuid, warehouse_uuid,
           product_uuid, server_sequence, rights_generation, lifecycle_generation,
           granted_quantity_milli, server_consumed_quantity_milli, server_remaining_quantity_milli,
           consume_until, status, server_status, envelope_hash, seal_nonce,
           final_consumption_sequence, final_consumption_hash, received_at, sealed_at,
           acknowledged_at, released_at, last_observed_revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid) DO UPDATE SET
           rights_generation = excluded.rights_generation,
           -- BH-04B-3: the legacy mirror is part of the update set. Leaving it behind is what made a
           -- re-ingested sealed envelope violate migration 0007's CHECK on every subsequent write.
           status = excluded.status,
           lifecycle_generation = excluded.lifecycle_generation,
           granted_quantity_milli = excluded.granted_quantity_milli,
           server_consumed_quantity_milli = excluded.server_consumed_quantity_milli,
           server_remaining_quantity_milli = excluded.server_remaining_quantity_milli,
           consume_until = excluded.consume_until,
           server_status = excluded.server_status,
           envelope_hash = excluded.envelope_hash,
           seal_nonce = excluded.seal_nonce,
           final_consumption_sequence = excluded.final_consumption_sequence,
           final_consumption_hash = excluded.final_consumption_hash,
           received_at = excluded.received_at,
           sealed_at = excluded.sealed_at,
           acknowledged_at = excluded.acknowledged_at,
           released_at = excluded.released_at,
           last_observed_revision = excluded.last_observed_revision,
           updated_at = excluded.updated_at`
      )
      .run(
        grant.allocationUuid,
        grant.contractVersion,
        grant.companyUuid,
        grant.deviceUuid,
        grant.warehouseUuid,
        grant.productUuid,
        grant.serverSequence,
        grant.rightsGeneration,
        grant.lifecycleGeneration,
        grant.grantedQuantityMilli,
        grant.consumedQuantityMilli,
        grant.remainingQuantityMilli,
        grant.consumeUntil,
        // BH-04B-3: the legacy compatibility mirror, derived from the authoritative server status.
        // Migration 0009 constrains the two to agree, so this is the only place either is written.
        legacyStatusFor(grant.status),
        grant.status,
        grant.envelopeHash,
        grant.sealNonce,
        grant.finalConsumptionSequence,
        grant.finalConsumptionHash,
        observedAt,
        grant.sealedAt,
        grant.acknowledgedAt,
        grant.releasedAt,
        revision,
        observedAt
      )
  }
}
