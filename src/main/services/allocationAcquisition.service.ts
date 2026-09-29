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
  IncomingCoverageBoundary,
  StockAllocationRepository
} from '../repositories/stockAllocation.repository'
import { runSerializedWrite } from '../database/serializedWrite'
import type {
  AllocationDispatchOutcome,
  AllocationDispatchRepository,
  AllocationDispatchRow
} from '../repositories/allocationDispatch.repository'
import type { AllocationReconciliationService } from './allocationReconciliation.service'
import {
  buildTopUpRequest,
  calculateAllocationDeficits,
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
  | 'context-changed'
  | 'policy-blocked'
  | 'allocation-acquisition-unresolved'
  | 'allocation-refused'
  | 'allocation-integrity-blocked'

/** The outcome of sending one recorded request identity. */
export type DispatchResolution =
  | { readonly kind: 'granted' }
  | { readonly kind: 'refused'; readonly code: AllocationAcquisitionBlock }
  | { readonly kind: 'integrity' }
  | { readonly kind: 'unresolved'; readonly code: AllocationAcquisitionBlock }

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
    'getCapability' | 'ingestTopUpGrants' | 'usableGrantsForProduct' | 'spendableMilli'
  >
  readonly allocationService: Pick<StockAllocationService, 'usableRemainingMilli'>
  /**
   * BH-04B-3. Optional so a caller that never negotiated the reconciliation representation — and
   * therefore never receives coverage — is unchanged. When absent, an opted-in response's coverage
   * is simply not applied; it is never approximated.
   */
  readonly allocationReconciliation?: Pick<AllocationReconciliationService, 'applyCoverage'>
  readonly connectivity: { getSnapshot(): ConnectivitySnapshot }
  /** Rev 3: durable request-identity evidence, written before every dispatch. */
  readonly allocationDispatches: Pick<
    AllocationDispatchRepository,
    | 'find'
    | 'listForAttempt'
    | 'insertForClaimedAttempt'
    | 'markSending'
    | 'recordAmbiguous'
    | 'recordUnproven'
    | 'resolve'
  >
  readonly now?: () => Date
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
  /** One HTTP request per recorded identity at a time, shared by acquisition and reconciliation. */
  private readonly sending = new Map<string, Promise<DispatchResolution>>()

  constructor(private readonly dependencies: AllocationAcquisitionDependencies) {
    this.log = dependencies.log ?? ((line) => console.info(line))
  }

  /**
   * POS reliability rev 3 — acquisition over durable request identities.
   *
   * 1. This attempt's own recorded requests that are still `dispatched` are re-sent first, byte for
   *    byte, under their original keys. No new identity is minted while one is outstanding.
   * 2. Only then is the current deficit computed. Its request identity is written to
   *    `attempt_allocation_dispatches` BEFORE the HTTP call (and only while the attempt is still
   *    claimed for this owner), so a lost response, crash or restart never loses it.
   * 3. Offline (main connectivity not proven online) nothing is sent: the local transaction decides
   *    under existing authority, and any outstanding row stays with the reconciler, which owns it
   *    independently of what happens to the sale attempt.
   */
  async acquire(params: {
    readonly attemptKey: string
    readonly owner: AllocationAcquisitionOwner
    readonly actorUserUuid: string
    readonly trackedLines: readonly TrackedDemandLine[]
    readonly nowIso: string
  }): Promise<AllocationAcquisitionOutcome> {
    const dispatches = this.dependencies.allocationDispatches
    const supported = this.dependencies.stockAllocations.getCapability()?.state === 'supported'
    const online = this.dependencies.connectivity.getSnapshot().status === 'online'

    const outstanding = dispatches
      .listForAttempt(params.attemptKey)
      .filter((row) => row.state === 'dispatched')
    if (outstanding.length > 0) {
      if (!supported || !online || !this.preconditionsHold()) {
        this.log(
          formatDiagnostic('top-up-skipped', {
            reason: 'outstanding_request_offline',
            outstanding: outstanding.length
          })
        )
        return { kind: 'proceed' }
      }
      for (const row of outstanding) {
        const resolution = await this.sendRecorded(row)
        if (resolution.kind === 'unresolved') {
          return { kind: 'blocked', code: resolution.code }
        }
        if (resolution.kind === 'integrity') {
          return { kind: 'blocked', code: 'allocation-integrity-blocked' }
        }
      }
    }

    if (
      dispatches
        .listForAttempt(params.attemptKey)
        .some((row) => row.state === 'conflict' || row.state === 'invalid')
    ) {
      return { kind: 'blocked', code: 'allocation-integrity-blocked' }
    }

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

    if (!supported) {
      // An older backend, or a device that has never completed an allocation-capable bootstrap.
      this.log(formatDiagnostic('top-up-skipped', { reason: 'allocation_capability_absent' }))
      return { kind: 'proceed' }
    }

    // Main owns connectivity classification. `unknown`/`checking` is never treated as proven
    // online, and the renderer's own view of connectivity is advisory and never consulted here.
    if (!online) {
      this.log(
        formatDiagnostic('top-up-skipped', { reason: 'offline', products: deficit.items.length })
      )
      return { kind: 'proceed' }
    }

    if (!this.preconditionsHold()) {
      // No request was dispatched, so this is unambiguous: the existing offline fail-closed path
      // (zero writes, `stock-allocation-unavailable` with affected line IDs) is correct.
      this.log(formatDiagnostic('top-up-skipped', { reason: 'request_preconditions' }))
      return { kind: 'proceed' }
    }

    const body = buildTopUpRequest(params.attemptKey, deficit.items)
    const existing = dispatches.find(body.idempotency_key)

    if (existing?.state === 'granted') {
      // The server already answered this exact request and its grants are stored. A replay would
      // return the same grants; the local transaction decides whether they cover the sale.
      this.log(formatDiagnostic('top-up-already-granted', { products: deficit.items.length }))
      return { kind: 'proceed' }
    }
    if (existing?.state === 'conflict' || existing?.state === 'invalid') {
      return { kind: 'blocked', code: 'allocation-integrity-blocked' }
    }

    if (!existing) {
      const inserted = runSerializedWrite(this.dependencies.database, () =>
        dispatches.insertForClaimedAttempt({
          attemptKey: params.attemptKey,
          owner: { ...params.owner, actorUserUuid: params.actorUserUuid },
          body,
          createdAt: params.nowIso
        })
      )
      if (!inserted) {
        // The attempt is no longer claimed for this owner (abandoned, rejected or foreign):
        // nothing was sent and nothing is recorded.
        return { kind: 'blocked', code: 'context-changed' }
      }
    }

    const row = dispatches.find(body.idempotency_key)
    if (!row) {
      return { kind: 'blocked', code: 'allocation-acquisition-unresolved' }
    }

    this.log(
      formatDiagnostic('top-up-requested', {
        products: deficit.items.length,
        requested_milli: deficit.items.reduce((sum, item) => sum + item.deficitMilli, 0)
      })
    )

    const resolution = await this.sendRecorded(row)
    switch (resolution.kind) {
      case 'granted': {
        // Authoritative re-read: coverage is recomputed from persisted rows, never from the
        // response. Reporting only — the local-sale transaction repeats it as the real gate.
        const remaining = calculateAllocationDeficits({
          trackedLines: params.trackedLines,
          usableMilliByProduct: this.usableMilliByProduct(
            params.owner,
            params.trackedLines,
            params.nowIso
          )
        })
        this.log(
          formatDiagnostic(
            remaining.kind === 'covered'
              ? 'post-persistence-coverage-passed'
              : 'post-persistence-coverage-failed',
            { tracked_products: this.productCount(params.trackedLines) }
          )
        )
        return { kind: 'proceed' }
      }
      case 'refused':
        return { kind: 'blocked', code: resolution.code }
      case 'integrity':
        return { kind: 'blocked', code: 'allocation-integrity-blocked' }
      case 'unresolved':
        return { kind: 'blocked', code: resolution.code }
    }
  }

  /**
   * Sends one RECORDED request exactly as recorded (same key, same bytes) and applies its outcome to
   * the dispatch row. Shared by acquisition and the reconciler through one per-key single-flight
   * gate, so at most one HTTP request per identity is ever in flight.
   */
  sendRecorded(row: AllocationDispatchRow): Promise<DispatchResolution> {
    const existing = this.sending.get(row.idempotencyKey)
    if (existing) {
      return existing
    }

    const started = this.sendOnce(row)
    this.sending.set(row.idempotencyKey, started)
    const clear = (): void => {
      if (this.sending.get(row.idempotencyKey) === started) {
        this.sending.delete(row.idempotencyKey)
      }
    }
    void started.then(clear, clear)
    return started
  }

  private preconditionsHold(): boolean {
    try {
      this.dependencies.apiClient.assertRequestPreconditions(
        DESKTOP_API_ROUTES.stockAllocationsTopUp
      )
      return true
    } catch {
      return false
    }
  }

  private nowIso(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString()
  }

  private async sendOnce(row: AllocationDispatchRow): Promise<DispatchResolution> {
    const dispatches = this.dependencies.allocationDispatches
    const owner: AllocationAcquisitionOwner = {
      companyUuid: row.companyUuid,
      deviceUuid: row.deviceUuid,
      warehouseUuid: row.warehouseUuid
    }
    const requestedProductUuids = new Set(
      row.requestBody.items.map((item) => item.product_uuid.toLowerCase())
    )

    runSerializedWrite(this.dependencies.database, () =>
      dispatches.markSending(row.idempotencyKey, this.nowIso())
    )

    let payload: { readonly data: unknown; readonly meta: Record<string, unknown> }
    try {
      payload = await this.dependencies.apiClient.requestWithMeta(
        DESKTOP_API_ROUTES.stockAllocationsTopUp,
        row.requestBody
      )
    } catch (error) {
      return this.applyFailure(row, error)
    }

    const receivedAt = this.nowIso()
    let grants: readonly BootstrapStockAllocationGrant[]
    let revision: number
    let coverage: readonly IncomingCoverageBoundary[] = []
    try {
      const allocations = desktopStockAllocationTopUpDataSchema.parse(payload.data)
      revision = desktopStockAllocationTopUpMetaSchema.parse(payload.meta).allocation_revision
      const capability = this.dependencies.stockAllocations.getCapability()

      // Plan §3.3: a response older than the snapshot this device is already selling against
      // describes a server view that has since moved and is never persisted as current authority.
      if (
        capability?.state !== 'supported' ||
        capability.revision === null ||
        revision < capability.revision
      ) {
        throw envelopeError('a stale or unavailable allocation revision')
      }

      grants = allocations.map((allocation) =>
        toGrant(allocation, owner, requestedProductUuids, receivedAt)
      )
      coverage = allocations.flatMap((allocation) =>
        'accepted_chain_hash' in allocation
          ? [
              {
                allocationUuid: allocation.id,
                rightsGeneration: allocation.rights_generation,
                acceptedConsumptionSequence: allocation.accepted_consumption_sequence,
                acceptedConsumedQuantityMilli: allocation.accepted_consumed_quantity_milli,
                acceptedChainHash: allocation.accepted_chain_hash
              }
            ]
          : []
      )
    } catch {
      // A malformed or stale success body proves the server stored a request under this key but
      // not what it holds: never burn a new key over it. The row stays outstanding.
      this.log(
        formatDiagnostic('top-up-response-malformed', { products: requestedProductUuids.size })
      )
      this.recordAmbiguous(row, { kind: 'ambiguous', reason: 'malformed_or_stale_body' }, null)
      return { kind: 'unresolved', code: 'allocation-acquisition-unresolved' }
    }

    this.log(
      formatDiagnostic('top-up-response-accepted', {
        granted_allocations: grants.length,
        granted_milli: grants.reduce((sum, grant) => sum + grant.grantedQuantityMilli, 0),
        allocation_revision: revision
      })
    )

    try {
      // One short transaction, opened only after the HTTP call settled: exactly-once grant ingest,
      // any coverage they carried, and the dispatch resolution — all or nothing.
      runSerializedWrite(this.dependencies.database, () => {
        this.dependencies.stockAllocations.ingestTopUpGrants(grants, receivedAt)

        for (const boundary of coverage) {
          this.dependencies.allocationReconciliation?.applyCoverage(
            boundary,
            { companyUuid: owner.companyUuid, deviceUuid: owner.deviceUuid },
            'top_up',
            receivedAt
          )
        }

        dispatches.resolve(
          row.idempotencyKey,
          'granted',
          { kind: 'response', httpStatus: 200, reason: `grants=${grants.length}` },
          receivedAt
        )
      })
    } catch (error) {
      this.log(
        formatDiagnostic('top-up-persistence-failed', {
          reason: error instanceof Error ? error.name : 'unknown'
        })
      )
      this.recordAmbiguous(row, { kind: 'ambiguous', reason: 'persist_failed' }, null)
      return { kind: 'unresolved', code: 'allocation-acquisition-unresolved' }
    }

    this.log(formatDiagnostic('grant-persistence-committed', { grants: grants.length }))
    return { kind: 'granted' }
  }

  /**
   * Classifies one failed send of a RECORDED request. Proof about the key is only ever taken from
   * where the refusal happened on the server (`StockAllocationService::topUp` order: form request →
   * device lock → quarantine → idempotency lookup → demand checks):
   *
   * - `STOCK_ALLOCATION_DEMAND_REFUSED` is raised after the idempotency lookup, so this key holds
   *   no server row: `refused` (re-sendable; it may succeed once server state changes).
   * - `IDEMPOTENCY_CONFLICT`: the server holds this key with a different request: `conflict`.
   * - `VALIDATION_ERROR` on the request shape: these exact bytes can never pass: `invalid`.
   * - Every other definitive 4xx happens BEFORE the lookup. It proves nothing about the key by
   *   itself; it proves "no server row" only if every earlier send of this key also received a
   *   definitive answer (`ambiguous_send_count = 0`). Otherwise the row stays outstanding.
   * - Transport loss, timeout, 429/5xx or anything unexpected: outstanding, Retry-After honoured.
   */
  private applyFailure(row: AllocationDispatchRow, error: unknown): DispatchResolution {
    if (!isPublicAppError(error)) {
      this.log(formatDiagnostic('top-up-transport-ambiguous', { classification: 'unknown' }))
      this.recordAmbiguous(row, { kind: 'ambiguous', reason: 'unknown_failure' }, null)
      return { kind: 'unresolved', code: 'allocation-acquisition-unresolved' }
    }

    const evidence: AllocationDispatchOutcome = {
      kind: 'error',
      category: error.category,
      ...(error.backendCode ? { backendCode: error.backendCode } : {}),
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      ...(error.traceId ? { traceId: error.traceId } : {})
    }

    if (error.backendCode === 'STOCK_ALLOCATION_DEMAND_REFUSED') {
      this.log(formatDiagnostic('top-up-rejected', { classification: 'demand_refused' }))
      this.resolveRow(row, 'refused', evidence)
      return { kind: 'refused', code: 'allocation-refused' }
    }

    if (error.backendCode === 'IDEMPOTENCY_CONFLICT') {
      this.log(formatDiagnostic('top-up-rejected', { classification: 'identity_conflict' }))
      this.resolveRow(row, 'conflict', evidence)
      return { kind: 'integrity' }
    }

    switch (error.category) {
      case 'validation':
        if (error.fieldErrors && Object.hasOwn(error.fieldErrors, 'device')) {
          this.log(formatDiagnostic('top-up-rejected', { classification: 'device' }))
          return this.preLookupDenial(row, evidence, 'workstation-unassigned')
        }
        this.log(formatDiagnostic('top-up-rejected', { classification: 'invalid_request' }))
        this.resolveRow(row, 'invalid', evidence)
        return { kind: 'integrity' }
      case 'authorization':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'authorization' }))
        return this.preLookupDenial(row, evidence, 'permission-denied')
      case 'authentication':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'authentication' }))
        return this.preLookupDenial(row, evidence, 'policy-blocked')
      case 'rejected':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'commercial' }))
        return this.preLookupDenial(row, evidence, 'context-changed')
      case 'configuration':
        this.log(formatDiagnostic('top-up-rejected', { classification: 'configuration' }))
        return this.preLookupDenial(row, evidence, 'context-changed')
      case 'conflict':
        // e.g. an open allocation quarantine (409 CONFLICT, raised before the lookup).
        this.log(formatDiagnostic('top-up-rejected', { classification: 'conflict' }))
        return this.preLookupDenial(row, evidence, 'allocation-acquisition-unresolved')
      default: {
        this.log(formatDiagnostic('top-up-transport-ambiguous', { classification: error.category }))
        const retryAfter =
          typeof error.retryAfterSeconds === 'number'
            ? new Date(Date.parse(this.nowIso()) + error.retryAfterSeconds * 1000).toISOString()
            : null
        this.recordAmbiguous(row, { ...evidence, kind: 'ambiguous' }, retryAfter)
        return { kind: 'unresolved', code: 'allocation-acquisition-unresolved' }
      }
    }
  }

  private preLookupDenial(
    row: AllocationDispatchRow,
    evidence: AllocationDispatchOutcome,
    code: AllocationAcquisitionBlock
  ): DispatchResolution {
    if (row.ambiguousSendCount === 0) {
      this.resolveRow(row, 'refused', evidence)
      return { kind: 'refused', code }
    }
    runSerializedWrite(this.dependencies.database, () =>
      this.dependencies.allocationDispatches.recordUnproven(row.idempotencyKey, evidence, null)
    )
    return { kind: 'unresolved', code }
  }

  private resolveRow(
    row: AllocationDispatchRow,
    state: 'refused' | 'conflict' | 'invalid',
    evidence: AllocationDispatchOutcome
  ): void {
    runSerializedWrite(this.dependencies.database, () =>
      this.dependencies.allocationDispatches.resolve(
        row.idempotencyKey,
        state,
        evidence,
        this.nowIso()
      )
    )
  }

  private recordAmbiguous(
    row: AllocationDispatchRow,
    evidence: AllocationDispatchOutcome,
    retryNotBefore: string | null
  ): void {
    try {
      runSerializedWrite(this.dependencies.database, () =>
        this.dependencies.allocationDispatches.recordAmbiguous(
          row.idempotencyKey,
          evidence,
          retryNotBefore
        )
      )
    } catch {
      // The row is still `dispatched` (markSending committed before the call), which is the safe
      // direction: it stays outstanding and is re-sent under the same identity.
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
