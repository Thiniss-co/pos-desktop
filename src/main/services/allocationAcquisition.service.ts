import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { SqliteDatabase } from '../database/connection'
import { isPublicAppError, redactSensitiveText } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  desktopStockAllocationTopUpDataSchema,
  desktopStockAllocationTopUpMetaSchema,
  type StockAllocationResource
} from '../http/desktopResources.contract'
import type {
  BootstrapStockAllocationGrant,
  StockAllocationRepository
} from '../repositories/stockAllocation.repository'
import {
  buildTopUpRequest,
  calculateAllocationDeficits,
  type AllocationDeficitItem,
  type TrackedDemandLine
} from './allocationDeficit'
import type { StockAllocationService } from './stockAllocation.service'

/**
 * The single allocation envelope contract version this desktop build understands. Laravel publishes
 * it as `config('stock_allocations.contract_version')`. An unknown version is fail-closed: a newer
 * envelope may carry lifecycle semantics this build would misread as sale authority.
 */
export const SUPPORTED_ALLOCATION_CONTRACT_VERSION = 1

/**
 * Precise, non-terminal completion codes an acquisition can end on. Each preserves the real reason
 * (CP-5D-D5) instead of collapsing an authority, device, or catalog denial into a stock message, and
 * each leaves the sale attempt `claimed` with zero business writes so the *same* attempt — and
 * therefore the same derived idempotency key — is retried rather than replaced.
 */
export type AllocationAcquisitionBlock =
  | 'permission-denied'
  | 'workstation-unassigned'
  | 'refresh-required'
  | 'context-changed'
  | 'policy-blocked'
  | 'allocation-acquisition-unresolved'

export type AllocationAcquisitionOutcome =
  /**
   * Hand control back to the authoritative local-sale transaction. It re-reads the grants from
   * SQLite and re-runs every guard, so this is *not* an assertion that the sale may commit — a
   * server that granted less than the exact deficit still fails closed there.
   */
  | { readonly kind: 'proceed' }
  /** Stop before the business transaction; nothing was written and the attempt stays retryable. */
  | { readonly kind: 'blocked'; readonly code: AllocationAcquisitionBlock }

export interface AllocationAcquisitionOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
}

export interface AllocationAcquisitionDependencies {
  readonly database: SqliteDatabase
  readonly apiClient: Pick<DesktopApiClient, 'requestWithMeta' | 'assertRequestPreconditions'>
  readonly stockAllocations: Pick<
    StockAllocationRepository,
    'getCapability' | 'ingestTopUpGrants' | 'usableGrantsForProduct' | 'remainingMilli'
  >
  readonly allocationService: Pick<StockAllocationService, 'usableRemainingMilli'>
  readonly connectivity: { getSnapshot(): ConnectivitySnapshot }
  readonly log?: (line: string) => void
}

/**
 * CP-5D-G sanitized diagnostics. Only categorical values and counts are ever emitted: no token,
 * device secret, payment reference, customer field, cart intent, raw allocation payload, request or
 * journal hash, allocation/product identifier, or database path.
 */
function formatDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): string {
  const rendered = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  return redactSensitiveText(`[pos-allocation] event=${event}${rendered ? ` ${rendered}` : ''}`)
}

function envelopeError(reason: string): Error {
  return new Error(`The stock allocation top-up response is invalid: ${reason}`)
}

/**
 * Maps one strict server envelope onto the durable grant shape, re-checking every ownership and
 * quantity fact the desktop treats as authority. Allocation fields drive stock and calculation, so
 * this is exact validation, never passthrough: an envelope that names another company, device,
 * warehouse, or an unrequested product is rejected as a whole rather than partially trusted.
 */
function toGrant(
  allocation: StockAllocationResource,
  owner: AllocationAcquisitionOwner,
  requestedProductUuids: ReadonlySet<string>,
  receivedAt: string
): BootstrapStockAllocationGrant {
  if (allocation.contract_version !== SUPPORTED_ALLOCATION_CONTRACT_VERSION) {
    throw envelopeError('unsupported contract version')
  }
  if (
    allocation.company_uuid !== owner.companyUuid ||
    allocation.device_uuid !== owner.deviceUuid ||
    allocation.warehouse_uuid !== owner.warehouseUuid
  ) {
    throw envelopeError('foreign company, device, or warehouse ownership')
  }
  if (!requestedProductUuids.has(allocation.product_uuid.toLowerCase())) {
    throw envelopeError('a product that was not requested')
  }
  if (
    allocation.lifecycle_generation < allocation.rights_generation ||
    allocation.consumed_quantity_milli > allocation.granted_quantity_milli ||
    allocation.remaining_quantity_milli !==
      allocation.granted_quantity_milli - allocation.consumed_quantity_milli
  ) {
    throw envelopeError('inconsistent grant quantities')
  }

  return {
    allocationUuid: allocation.id,
    contractVersion: allocation.contract_version,
    companyUuid: allocation.company_uuid,
    deviceUuid: allocation.device_uuid,
    warehouseUuid: allocation.warehouse_uuid,
    productUuid: allocation.product_uuid,
    serverSequence: allocation.server_sequence,
    rightsGeneration: allocation.rights_generation,
    lifecycleGeneration: allocation.lifecycle_generation,
    grantedQuantityMilli: allocation.granted_quantity_milli,
    consumedQuantityMilli: allocation.consumed_quantity_milli,
    remainingQuantityMilli: allocation.remaining_quantity_milli,
    consumeUntil: allocation.consume_until,
    // Server lifecycle is preserved verbatim. A replayed grant that has since moved to
    // `revocation_pending`, `seal_acknowledged`, `released`, or `consumed` is stored as such and
    // simply fails the coverage re-read; it is never normalized back to `active`.
    status: allocation.status,
    envelopeHash: allocation.envelope_hash,
    sealNonce: allocation.seal_nonce,
    finalConsumptionSequence: allocation.final_consumption_sequence,
    finalConsumptionHash: allocation.final_consumption_hash,
    receivedAt,
    sealedAt: allocation.sealed_at,
    acknowledgedAt: allocation.acknowledged_at,
    releasedAt: allocation.released_at
  }
}

/**
 * Phase 3F CP-5D — the production caller that obtains exact-deficit server allocations for the
 * tracked lines of one cart while connected, persists them atomically, and revalidates them from
 * SQLite before the existing local-sale transaction is allowed to run.
 *
 * Invariants this class exists to hold:
 *
 * - it requests **only** the arithmetic deficit of the current cart — never a buffer, never the
 *   product's stock, never the warehouse's availability, and never during catalog/workstation
 *   refresh;
 * - it never opens a SQLite transaction across the HTTP call: coverage is read, the request is
 *   dispatched, and only the response is persisted, in one short synchronous transaction;
 * - it writes no invoice, payment, movement, consumption, or queue row on any path, and nothing at
 *   all unless the server returned a valid grant;
 * - it never creates, updates, releases, reassigns, expires, or fabricates allocation rows itself;
 *   the only rows it writes are verbatim server envelopes.
 */
export class AllocationAcquisitionService {
  private readonly log: (line: string) => void

  constructor(private readonly dependencies: AllocationAcquisitionDependencies) {
    this.log = dependencies.log ?? ((line) => console.info(line))
  }

  async acquire(params: {
    readonly attemptKey: string
    readonly owner: AllocationAcquisitionOwner
    readonly trackedLines: readonly TrackedDemandLine[]
    readonly nowIso: string
  }): Promise<AllocationAcquisitionOutcome> {
    const deficit = calculateAllocationDeficits({
      trackedLines: params.trackedLines,
      usableMilliByProduct: this.usableMilliByProduct(
        params.owner,
        params.trackedLines,
        params.nowIso
      )
    })

    if (deficit.kind === 'covered') {
      // Offline-capable path: a sufficient persisted grant completes the sale with zero HTTP.
      this.log(
        formatDiagnostic('top-up-not-required', {
          tracked_products: this.productCount(params.trackedLines)
        })
      )
      return { kind: 'proceed' }
    }

    if (deficit.kind === 'unrepresentable') {
      // Fail closed as one request rather than partitioning it: Laravel defines idempotent replay
      // for a single request hash, not safe batch replay across independently authorized parts.
      this.log(
        formatDiagnostic('top-up-unrepresentable', {
          affected_lines: deficit.affectedLineIds.length
        })
      )
      return { kind: 'proceed' }
    }

    if (this.dependencies.stockAllocations.getCapability()?.state !== 'supported') {
      // An older backend, or a device that has never completed an allocation-capable bootstrap.
      this.log(formatDiagnostic('top-up-skipped', { reason: 'allocation_capability_absent' }))
      return { kind: 'proceed' }
    }

    // Main owns connectivity classification. `unknown`/`checking` is never treated as proven
    // online, and the renderer's own view of connectivity is advisory and never consulted here.
    if (this.dependencies.connectivity.getSnapshot().status !== 'online') {
      this.log(
        formatDiagnostic('top-up-skipped', { reason: 'offline', products: deficit.items.length })
      )
      return { kind: 'proceed' }
    }

    try {
      this.dependencies.apiClient.assertRequestPreconditions(
        DESKTOP_API_ROUTES.stockAllocationsTopUp
      )
    } catch {
      // No request was dispatched, so this is unambiguous: the existing offline fail-closed path
      // (zero writes, `stock-allocation-unavailable` with affected line IDs) is correct.
      this.log(formatDiagnostic('top-up-skipped', { reason: 'request_preconditions' }))
      return { kind: 'proceed' }
    }

    return this.dispatch(
      params.attemptKey,
      params.owner,
      deficit.items,
      params.trackedLines,
      params.nowIso
    )
  }

  private async dispatch(
    attemptKey: string,
    owner: AllocationAcquisitionOwner,
    items: readonly AllocationDeficitItem[],
    trackedLines: readonly TrackedDemandLine[],
    nowIso: string
  ): Promise<AllocationAcquisitionOutcome> {
    const body = buildTopUpRequest(attemptKey, items)
    const requestedProductUuids = new Set(items.map((item) => item.productUuid))
    const requestedMilli = items.reduce((sum, item) => sum + item.deficitMilli, 0)

    this.log(
      formatDiagnostic('top-up-requested', {
        products: items.length,
        requested_milli: requestedMilli
      })
    )

    let payload: { readonly data: unknown; readonly meta: Record<string, unknown> }
    try {
      payload = await this.dependencies.apiClient.requestWithMeta(
        DESKTOP_API_ROUTES.stockAllocationsTopUp,
        body
      )
    } catch (error) {
      return { kind: 'blocked', code: this.classifyDispatchFailure(error) }
    }

    let grants: readonly BootstrapStockAllocationGrant[]
    let revision: number
    try {
      const allocations = desktopStockAllocationTopUpDataSchema.parse(payload.data)
      revision = desktopStockAllocationTopUpMetaSchema.parse(payload.meta).allocation_revision
      const capability = this.dependencies.stockAllocations.getCapability()

      // Plan §3.3: the monotonic allocation revision exists so a stale generation can be rejected.
      // A response older than the snapshot this device is already selling against describes a
      // server view that has since moved, and must never be persisted as current authority.
      if (
        capability?.state !== 'supported' ||
        capability.revision === null ||
        revision < capability.revision
      ) {
        throw envelopeError('a stale or unavailable allocation revision')
      }

      grants = allocations.map((allocation) =>
        toGrant(allocation, owner, requestedProductUuids, nowIso)
      )
    } catch {
      // A malformed success body is ambiguous, not definitive: Laravel may well have created and
      // reserved the grants. Never burn a new idempotency key over it — the same attempt replays
      // the identical request and receives the stored, effect-free result.
      this.log(formatDiagnostic('top-up-response-malformed', { products: items.length }))
      return { kind: 'blocked', code: 'allocation-acquisition-unresolved' }
    }

    this.log(
      formatDiagnostic('top-up-response-accepted', {
        granted_allocations: grants.length,
        granted_milli: grants.reduce((sum, grant) => sum + grant.grantedQuantityMilli, 0),
        allocation_revision: revision,
        // A replay returns 200/`STOCK_ALLOCATIONS_ALREADY_GRANTED` with the originally stored
        // grants; the desktop cannot see the status code here, but a grant it already holds is the
        // observable signature of one.
        replayed: grants.every(
          (grant) => this.dependencies.stockAllocations.remainingMilli(grant.allocationUuid) > 0
        )
      })
    )

    try {
      // One short synchronous better-sqlite3 transaction, opened only *after* the HTTP call has
      // fully settled. All-or-nothing: a conflicting or foreign grant rolls the whole set back.
      this.dependencies.database.transaction(() =>
        this.dependencies.stockAllocations.ingestTopUpGrants(grants, nowIso)
      )()
    } catch (error) {
      this.log(
        formatDiagnostic('top-up-persistence-failed', {
          reason: error instanceof Error ? error.name : 'unknown'
        })
      )
      return { kind: 'blocked', code: 'allocation-acquisition-unresolved' }
    }

    this.log(formatDiagnostic('grant-persistence-committed', { grants: grants.length }))

    // Authoritative re-read: coverage is recomputed from persisted rows, never from the response
    // that was just parsed. Reporting only — the local-sale transaction repeats it as the real gate.
    const remaining = calculateAllocationDeficits({
      trackedLines,
      usableMilliByProduct: this.usableMilliByProduct(owner, trackedLines, nowIso)
    })
    this.log(
      formatDiagnostic(
        remaining.kind === 'covered'
          ? 'post-persistence-coverage-passed'
          : 'post-persistence-coverage-failed',
        { tracked_products: this.productCount(trackedLines) }
      )
    )

    return { kind: 'proceed' }
  }

  /**
   * Definitive backend rejections create no invoice, payment, movement, allocation consumption, or
   * queue row and keep their real reason. Anything whose server-side effect cannot be known — a
   * transport failure, a timeout, a 429/5xx, or an idempotency conflict that proves an earlier
   * request under this key already landed — is `allocation-acquisition-unresolved`: fail closed,
   * same attempt, same key, explicit cashier-driven retry.
   */
  private classifyDispatchFailure(error: unknown): AllocationAcquisitionBlock {
    if (!isPublicAppError(error)) {
      this.log(formatDiagnostic('top-up-transport-ambiguous', { classification: 'unknown' }))
      return 'allocation-acquisition-unresolved'
    }

    switch (error.category) {
      case 'authorization':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'authorization' }))
        return 'permission-denied'
      case 'authentication':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'authentication' }))
        return 'policy-blocked'
      case 'validation':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'validation' }))
        // `StockAllocationService::lockGrantDevice()` reports a missing/moved warehouse assignment
        // on the `device` field; every other validation arm means the local catalog disagrees with
        // the server about which products are tracked and company-owned.
        return error.fieldErrors && Object.hasOwn(error.fieldErrors, 'device')
          ? 'workstation-unassigned'
          : 'refresh-required'
      case 'rejected':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'commercial' }))
        return 'context-changed'
      case 'configuration':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'configuration' }))
        return 'context-changed'
      default:
        this.log(formatDiagnostic('top-up-transport-ambiguous', { classification: error.category }))
        return 'allocation-acquisition-unresolved'
    }
  }

  private usableMilliByProduct(
    owner: AllocationAcquisitionOwner,
    trackedLines: readonly TrackedDemandLine[],
    nowIso: string
  ): ReadonlyMap<string, number> {
    const usable = new Map<string, number>()

    for (const productUuid of new Set(trackedLines.map((line) => line.productUuid.toLowerCase()))) {
      usable.set(
        productUuid,
        this.dependencies.allocationService.usableRemainingMilli(owner, productUuid, nowIso)
      )
    }

    return usable
  }

  private productCount(trackedLines: readonly TrackedDemandLine[]): number {
    return new Set(trackedLines.map((line) => line.productUuid.toLowerCase())).size
  }
}
