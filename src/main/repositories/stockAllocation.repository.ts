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

export interface AllocationCapability {
  readonly state: 'supported' | 'unavailable'
  readonly revision: number | null
  readonly observedAt: string
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
    createdAt: row.created_at as string
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
        'SELECT state, revision, observed_at FROM bootstrap_allocation_capability WHERE id = 1'
      )
      .get() as
      | {
          readonly state: AllocationCapability['state']
          readonly revision: number | null
          readonly observed_at: string
        }
      | undefined

    return row ? { state: row.state, revision: row.revision, observedAt: row.observed_at } : null
  }

  /** Records an older backend explicitly; retained grants cannot act as current authority. */
  markCapabilityUnavailable(observedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO bootstrap_allocation_capability (id, state, revision, observed_at)
         VALUES (1, 'unavailable', NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           revision = excluded.revision,
           observed_at = excluded.observed_at`
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
    observedAt: string
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

    this.database
      .prepare(
        `INSERT INTO bootstrap_allocation_capability (id, state, revision, observed_at)
         VALUES (1, 'supported', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           revision = excluded.revision,
           observed_at = excluded.observed_at`
      )
      .run(revision, observedAt)
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

  /** Only current, server-active grants with no unknown server journal sequence can be consumed. */
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
    return (
      this.database
        .prepare(
          `SELECT * FROM stock_allocation_grants
             WHERE company_uuid = ? AND device_uuid = ? AND warehouse_uuid = ? AND product_uuid = ?
               AND COALESCE(server_status, status) = 'active'
               AND consume_until > ?
               AND server_consumed_quantity_milli = 0
               AND (? IS NULL OR last_observed_revision = ?)
             ORDER BY consume_until ASC, server_sequence ASC, allocation_uuid ASC`
        )
        .all(
          owner.companyUuid,
          owner.deviceUuid,
          owner.warehouseUuid,
          productUuid,
          nowIso,
          currentRevision,
          currentRevision
        ) as Record<string, unknown>[]
    ).map(mapGrantRow)
  }

  /** Server remaining rights less only local consumptions not yet acknowledged by a server. */
  remainingMilli(allocationUuid: string): number {
    const grant = this.findGrantByUuid(allocationUuid)
    if (!grant) {
      return 0
    }

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

  insertConsumption(
    consumption: NewLocalStockAllocationConsumption
  ): LocalStockAllocationConsumptionRow {
    this.database
      .prepare(
        `INSERT INTO local_stock_allocation_consumptions (
           local_uuid, allocation_uuid, consumption_sequence, invoice_local_uuid, item_local_uuid,
           quantity_milli, server_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        consumption.localUuid,
        consumption.allocationUuid,
        consumption.consumptionSequence,
        consumption.invoiceLocalUuid,
        consumption.itemLocalUuid,
        consumption.quantityMilli,
        consumption.createdAt
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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid) DO UPDATE SET
           rights_generation = excluded.rights_generation,
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
