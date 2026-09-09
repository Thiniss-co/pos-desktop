import { randomUUID } from 'node:crypto'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import { redactSensitiveText } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  prepareOperationResourceSchema,
  type PrepareOperationResource
} from '../http/desktopResources.contract'
import type {
  BootstrapStockAllocationGrant,
  StockAllocationRepository
} from '../repositories/stockAllocation.repository'
import type {
  PrepareOperationRow,
  PrepareOutcome,
  PrepareOwner,
  PreparationRepository
} from '../repositories/preparation.repository'
import { evaluateCompleteness } from './preparationCompleteness'
import type { CapturedQueueRow } from './preparationDependencies'
import { partitionCandidates } from './preparationDependencies'
import {
  buildPrepareRequest,
  replayBodyFromCanonical,
  type CanonicalPrepareRequest
} from './preparationRequest'
import { SUPPORTED_ALLOCATION_CONTRACT_VERSION } from './allocationAcquisition.service'

/**
 * CP3 — the durable local preparation lifecycle (plan §5.6, §7.2).
 *
 * The ordering discipline this class exists to hold, in one place so it can be checked:
 *
 * ```text
 * capture cycle boundary   (one SQLite transaction)
 *   -> partition           (pure, in memory)
 *   -> freeze operation    (one SQLite transaction; bytes immutable from here)
 *   -> mark dispatching    (one SQLite transaction, BEFORE the request leaves)
 *   -> HTTP                (NO transaction is open)
 *   -> apply or classify   (one SQLite transaction)
 * ```
 *
 * **No HTTP ever happens inside a SQLite write transaction.** That is a hard plan invariant, and
 * splitting the persistence into short transactions around the call is what satisfies it.
 *
 * Marking `dispatching` before the request leaves is the other load-bearing detail. §7.2 makes
 * ambiguity the *default* classification: an implementation that cannot prove a request never left
 * must treat it as ambiguous. A durable write is the only thing that survives process death, so an
 * in-memory flag would silently downgrade a possibly-dispatched operation to "provably undispatched"
 * after a crash — and editing or replacing a body that may already have reached Laravel is exactly
 * what produces either a 409 or a second, unlinked grant.
 */

export type PrepareCycleOutcome =
  | { readonly kind: 'applied'; readonly operationUuid: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'ambiguous'; readonly operationUuid: string }
  | { readonly kind: 'discovered_pending_replay'; readonly operationUuid: string }
  | { readonly kind: 'conflicted'; readonly operationUuid: string; readonly reason: string }
  | { readonly kind: 'superseded_uncommitted'; readonly operationUuid: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface PreparationCandidateSource {
  /**
   * The policy-enabled candidate product set, resolved by **main** from policy.
   *
   * §5.2 is categorical: a renderer may *ask* for preparation, but it never names the set. The
   * array the server receives is main's resolved eligible set, never a renderer list.
   */
  resolveCandidates(owner: PrepareOwner): Promise<readonly string[]> | readonly string[]
  /** Rows at or below the captured boundary whose journal touches a candidate. */
  capturedDependencies(owner: PrepareOwner, highWater: number): readonly CapturedQueueRow[]
  policyDisabledProducts(owner: PrepareOwner): ReadonlySet<string>
  blockedByUnreleasedHoldProducts(owner: PrepareOwner): ReadonlySet<string>
  /** The locally staged authority references, or null when none is staged. */
  authorityReferences(owner: PrepareOwner): {
    readonly licenseValidationUuid: string | null
    readonly catalogRevision: string | null
    readonly requestedPolicyRevision: number
  }
  /** Electron's own integer session epoch (§5.2). */
  sessionEpoch(): number
}

export interface PreparationServiceDependencies {
  readonly database: SqliteDatabase
  readonly preparation: PreparationRepository
  readonly stockAllocations: Pick<StockAllocationRepository, 'getCapability' | 'ingestTopUpGrants'>
  readonly apiClient: Pick<DesktopApiClient, 'requestWithMeta' | 'assertRequestPreconditions'>
  readonly connectivity: { getSnapshot(): ConnectivitySnapshot }
  readonly candidates: PreparationCandidateSource
  readonly now: () => string
  readonly newUuid?: () => string
  readonly log?: (line: string) => void
}

/** Sanitized categorical diagnostics only: no identifier, quantity, hash, token, or payload. */
function formatDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean>
): string {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  return redactSensitiveText(`[pos-preparation] event=${event}${rendered ? ` ${rendered}` : ''}`)
}

export class PreparationService {
  private readonly log: (line: string) => void
  private readonly newUuid: () => string

  constructor(private readonly dependencies: PreparationServiceDependencies) {
    this.log = dependencies.log ?? ((line) => console.info(line))
    this.newUuid = dependencies.newUuid ?? (() => randomUUID().toLowerCase())
  }

  /**
   * Run one preparation cycle end to end.
   *
   * Returns without dispatching when the eligible set is empty — a blocked cycle is a normal,
   * persisted terminal outcome with its reasons, not a failure, and §4.4 requires the UI to show it
   * rather than loop or mint a new operation.
   */
  async runCycle(owner: PrepareOwner): Promise<PrepareCycleOutcome> {
    // An unresolved operation must be settled before a new cycle may select its products (§5.6
    // step 5a). Resolving it first is not merely tidier: it is what stops a second operation from
    // being created for a product the server may already have charged.
    const unresolved = this.dependencies.preparation.unresolvedOperations(owner)

    if (unresolved.length > 0) {
      // §5.6 step 5a: an operation that is `captured`, `dispatching`, `ambiguous`, or
      // `discovered_pending_replay` is resolved by **exact replay** — or by §5.4 discovery —
      // before any new cycle may select its products.
      //
      // All four states resume, not just the pre-dispatch ones. Falling through to a new cycle
      // instead would partition the unresolved operation's products into the blocked set and
      // terminate as `blocked`, which is technically safe but useless: the operation would never be
      // retried, and the device would sit permanently unable to prepare products the server may
      // already have granted. Replaying the identical frozen bytes under the identical identity is
      // always safe and is the only thing that can actually close it.
      return this.resumeOperation(unresolved[0] as PrepareOperationRow)
    }

    const candidates = await this.dependencies.candidates.resolveCandidates(owner)

    if (candidates.length === 0) {
      return { kind: 'blocked', reason: 'no_candidate_products' }
    }

    const frozen = this.captureAndFreeze(owner, candidates)

    if (frozen.kind === 'blocked') {
      this.log(formatDiagnostic('cycle-blocked', { reason: frozen.reason }))
      return frozen
    }

    return this.dispatch(frozen.operationUuid, frozen.request)
  }

  /**
   * §7.2 steps 1-4, in two short transactions with a pure partition between them.
   *
   * The capture transaction reads the high-water mark and persists the cycle together, so a queue
   * row committed concurrently either lands below the mark and is captured, or lands above it and
   * belongs to the next cycle. There is no third possibility — which is what stops continuous
   * selling from starving a cycle rather than merely making it unlikely.
   */
  private captureAndFreeze(
    owner: PrepareOwner,
    candidateProductUuids: readonly string[]
  ):
    | {
        readonly kind: 'frozen'
        readonly operationUuid: string
        readonly request: CanonicalPrepareRequest
      }
    | { readonly kind: 'blocked'; readonly reason: string } {
    const cycleUuid = this.newUuid()
    const authority = this.dependencies.candidates.authorityReferences(owner)
    const sessionEpoch = this.dependencies.candidates.sessionEpoch()

    return runSerializedWrite(this.dependencies.database, () => {
      const highWater = this.dependencies.preparation.currentQueueHighWater()
      const capturedRows = this.dependencies.candidates.capturedDependencies(owner, highWater)

      const partition = partitionCandidates({
        candidateProductUuids,
        capturedRows,
        productsOwnedByUnresolvedOperations:
          this.dependencies.preparation.productsOwnedByUnresolvedOperations(owner),
        policyDisabledProductUuids: this.dependencies.candidates.policyDisabledProducts(owner),
        blockedByUnreleasedHoldProductUuids:
          this.dependencies.candidates.blockedByUnreleasedHoldProducts(owner)
      })

      this.dependencies.preparation.captureCycle({
        cycleUuid,
        owner,
        requestedPolicyRevision: authority.requestedPolicyRevision,
        capturedQueueHighWater: highWater,
        candidates: [
          ...partition.eligible.map((productUuid) => ({
            productUuid,
            disposition: 'eligible' as const,
            blockedReason: null
          })),
          ...partition.blocked.map((entry) => ({
            productUuid: entry.productUuid,
            disposition: 'blocked' as const,
            blockedReason: entry.reason
          }))
        ],
        dependencies: capturedRows.flatMap((row) => {
          const scopes: {
            productUuid: string | null
            allocationUuid: string | null
          }[] = row.scopeKnown
            ? [
                ...row.productUuids.map((productUuid) => ({ productUuid, allocationUuid: null })),
                ...row.allocationUuids.map((allocationUuid) => ({
                  productUuid: null,
                  allocationUuid
                }))
              ]
            : [{ productUuid: null, allocationUuid: null }]

          return scopes.map((scope) => ({
            localQueueUuid: row.localQueueUuid,
            queueSequence: row.queueSequence,
            queueState: row.state,
            productUuid: scope.productUuid,
            allocationUuid: scope.allocationUuid,
            scopeKnown: row.scopeKnown
          }))
        })
      })

      if (partition.eligible.length === 0) {
        // §7.2 step 4: the cycle terminates as blocked with its reasons and dispatches nothing.
        const reason = partition.blocked[0]?.reason ?? 'no_eligible_products'
        this.dependencies.preparation.markCycleBlocked(cycleUuid, reason)

        return { kind: 'blocked' as const, reason }
      }

      const request = buildPrepareRequest({
        operationUuid: this.newUuid(),
        requestedPolicyRevision: authority.requestedPolicyRevision,
        productUuids: partition.eligible,
        licenseValidationUuid: authority.licenseValidationUuid,
        catalogRevision: authority.catalogRevision
      })

      this.dependencies.preparation.freezeOperation({
        cycleUuid,
        operationUuid: request.operationUuid,
        owner,
        requestedPolicyRevision: authority.requestedPolicyRevision,
        canonicalRequestJson: request.canonicalJson,
        requestHash: request.requestHash,
        selectedProductUuids: request.productUuids,
        capturedSessionEpoch: sessionEpoch
      })

      return { kind: 'frozen' as const, operationUuid: request.operationUuid, request }
    })
  }

  /**
   * Resume an operation persisted by an earlier run — the restart and crash-recovery path.
   *
   * `captured` with no `dispatch_started_at` is the only state that can be *proven* undispatched,
   * and even then it is replayed rather than abandoned: replaying identical bytes under the
   * identical identity is always safe, whereas deciding it never left and re-freezing a smaller set
   * is safe only if the proof is airtight. Anything else is ambiguous by §7.2's default.
   */
  private async resumeOperation(operation: PrepareOperationRow): Promise<PrepareCycleOutcome> {
    this.log(
      formatDiagnostic('operation-resumed', {
        state: operation.state,
        dispatched: operation.dispatchStartedAt !== null
      })
    )

    return this.dispatch(operation.operationUuid, {
      operationUuid: operation.operationUuid,
      productUuids: operation.selectedProductUuids,
      canonicalJson: operation.canonicalRequestJson,
      requestHash: operation.requestHash,
      body: replayBodyFromCanonical(operation.operationUuid, operation.canonicalRequestJson)
    })
  }

  /**
   * Dispatch — or exactly replay — one frozen operation.
   *
   * The body is always the stored canonical bytes. It is never rebuilt from current local state,
   * never re-partitioned, and never re-hashed, whatever has changed since the freeze.
   */
  private async dispatch(
    operationUuid: string,
    request: CanonicalPrepareRequest
  ): Promise<PrepareCycleOutcome> {
    if (this.dependencies.connectivity.getSnapshot().status !== 'online') {
      // Not ambiguous: nothing was sent. The operation stays `captured` and provably undispatched,
      // and the next attempt replays the identical bytes.
      this.log(formatDiagnostic('dispatch-skipped', { reason: 'offline' }))
      return { kind: 'unavailable', reason: 'offline' }
    }

    try {
      this.dependencies.apiClient.assertRequestPreconditions(DESKTOP_API_ROUTES.offlineStockPrepare)
    } catch {
      this.log(formatDiagnostic('dispatch-skipped', { reason: 'request_preconditions' }))
      return { kind: 'unavailable', reason: 'request_preconditions' }
    }

    // Durably recorded BEFORE the request leaves, so a crash between here and the response is
    // classified as ambiguous rather than as provably undispatched.
    runSerializedWrite(this.dependencies.database, () => {
      this.dependencies.preparation.markDispatching(operationUuid)
    })

    let payload: { readonly data: unknown }
    try {
      payload = await this.dependencies.apiClient.requestWithMeta(
        DESKTOP_API_ROUTES.offlineStockPrepare,
        request.body
      )
    } catch (error) {
      return this.classifyDispatchFailure(operationUuid, error)
    }

    let response: PrepareOperationResource
    try {
      response = prepareOperationResourceSchema.parse(payload.data)
    } catch {
      // A malformed success body is ambiguous, not definitive: Laravel may well have committed the
      // decision and reserved the grants. Never burn a new operation identity over it.
      runSerializedWrite(this.dependencies.database, () => {
        this.dependencies.preparation.markAmbiguous(operationUuid)
      })
      this.log(formatDiagnostic('response-malformed', { outcome: 'ambiguous' }))

      return { kind: 'ambiguous', operationUuid }
    }

    return this.applyResponse(operationUuid, response)
  }

  /**
   * Apply a decision-complete response, atomically, or classify why it could not be applied.
   *
   * The grants are ingested and the decision is applied in **one** transaction (§5.4 item 6): a torn
   * application would leave the operation `applied` with an incomplete decision, which is exactly
   * the state the completeness predicate exists to make unreachable.
   */
  private applyResponse(
    operationUuid: string,
    response: PrepareOperationResource
  ): PrepareCycleOutcome {
    return runSerializedWrite(this.dependencies.database, () => {
      const operation = this.dependencies.preparation.findOperation(operationUuid)

      if (operation === null) {
        return { kind: 'unavailable' as const, reason: 'operation_missing' }
      }

      if (operation.state === 'applied') {
        // Already closed by an earlier run. Replay is inert.
        return { kind: 'applied' as const, operationUuid }
      }

      const grants = this.toGrants(operation, response)

      if (grants === null) {
        this.dependencies.preparation.markConflicted(operationUuid, 'invalid_grant_envelope')

        return {
          kind: 'conflicted' as const,
          operationUuid,
          reason: 'invalid_grant_envelope'
        }
      }

      const verdict = evaluateCompleteness({
        operation,
        response,
        discoveredAllocationUuids:
          this.dependencies.preparation.discoveredGrantUuids(operationUuid),
        ingestedAllocationUuids: grants.map((grant) => grant.allocationUuid)
      })

      // Grants are ingested whether or not the decision is complete. §5.4: an ingested grant is
      // spendable on its own, and withholding real authority because the *operation* is unresolved
      // would strand stock the server has already committed.
      if (grants.length > 0) {
        this.dependencies.stockAllocations.ingestTopUpGrants(grants, this.dependencies.now())

        for (const grant of grants) {
          this.dependencies.preparation.recordDiscoveredGrant({
            operationUuid,
            allocationUuid: grant.allocationUuid,
            productUuid: grant.productUuid
          })
        }
      }

      if (verdict.kind === 'incomplete') {
        // Never `applied`. The ingested grants stay spendable; the operation stays open, owns its
        // selected products, and is reported as unresolved rather than successful (§5.6, §8.6).
        this.dependencies.preparation.markAmbiguous(operationUuid)
        this.log(
          formatDiagnostic('decision-incomplete', {
            failure: verdict.failure,
            outcome: 'discovered_pending_replay'
          })
        )

        return grants.length > 0
          ? { kind: 'discovered_pending_replay' as const, operationUuid }
          : { kind: 'ambiguous' as const, operationUuid }
      }

      const manifest = response.decision.manifest

      this.dependencies.preparation.applyDecision({
        operationUuid,
        // The server's immutable anchors, stored verbatim. Nothing here is `now`-derived: §8.5
        // requires the countdown to measure from `prepared_at`, so that network or disk delay
        // cannot lengthen the window the server issued.
        preparedAt: manifest.prepared_at,
        requiredDurationSeconds: manifest.required_duration_seconds,
        requiredReadyUntil: manifest.required_ready_until,
        authorityReadyUntil: manifest.authority_ready_until,
        result: response.decision.result,
        primaryLimitingReason: response.decision.primary_limiting_reason,
        appliedPolicyRevision: response.decision.applied_policy_revision,
        manifestJson: JSON.stringify(manifest),
        authorityReferencesJson: JSON.stringify(response.decision.authority_references),
        outcomes: response.decision.products.map((product): PrepareOutcome => ({
          productUuid: product.product_uuid.toLowerCase(),
          reason: product.reason,
          grantedQuantityMilli: product.granted_quantity_milli,
          allocationUuid: product.allocation_uuid,
          issuedAt: product.issued_at,
          consumeUntil: product.consume_until,
          windowQualifiedHoldMilli: product.window_qualified_hold_milli,
          shortLivedHoldMilli: product.short_lived_hold_milli,
          expiredHoldMilli: product.expired_hold_milli,
          quarantinedHoldMilli: product.quarantined_hold_milli,
          blockingAllocationUuids: product.blocking_allocation_uuids
        }))
      })

      this.log(
        formatDiagnostic('decision-applied', {
          result: response.decision.result,
          products: response.decision.products.length,
          grants: grants.length
        })
      )

      return { kind: 'applied' as const, operationUuid }
    })
  }

  /**
   * Validate every returned grant against the operation's own owner tuple and selected set.
   *
   * Exact validation, never passthrough: allocation fields drive stock authority, so an envelope
   * naming another company, device, warehouse, or an unselected product is rejected as a whole
   * rather than partially trusted. Returns `null` on any violation.
   */
  private toGrants(
    operation: PrepareOperationRow,
    response: PrepareOperationResource
  ): readonly BootstrapStockAllocationGrant[] | null {
    const selected = new Set(operation.selectedProductUuids)
    const receivedAt = this.dependencies.now()
    const grants: BootstrapStockAllocationGrant[] = []

    for (const allocation of response.allocations) {
      if (
        allocation.contract_version !== SUPPORTED_ALLOCATION_CONTRACT_VERSION ||
        allocation.company_uuid !== operation.companyUuid ||
        allocation.device_uuid !== operation.deviceUuid ||
        allocation.warehouse_uuid !== operation.warehouseUuid ||
        !selected.has(allocation.product_uuid.toLowerCase()) ||
        allocation.lifecycle_generation < allocation.rights_generation ||
        allocation.consumed_quantity_milli > allocation.granted_quantity_milli ||
        allocation.remaining_quantity_milli !==
          allocation.granted_quantity_milli - allocation.consumed_quantity_milli
      ) {
        return null
      }

      // Provenance is server-assigned and must name *this* operation. A grant returned under this
      // operation but carrying another origin is a contract violation, not a grant to ingest.
      if (
        allocation.origin_operation_uuid !== null &&
        allocation.origin_operation_uuid.toLowerCase() !== operation.operationUuid
      ) {
        return null
      }

      grants.push({
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
        status: allocation.status,
        envelopeHash: allocation.envelope_hash,
        sealNonce: allocation.seal_nonce,
        finalConsumptionSequence: allocation.final_consumption_sequence,
        finalConsumptionHash: allocation.final_consumption_hash,
        receivedAt,
        sealedAt: allocation.sealed_at,
        acknowledgedAt: allocation.acknowledged_at,
        releasedAt: allocation.released_at
      })
    }

    return grants
  }

  /**
   * Classify a failed dispatch.
   *
   * Only two server answers are definitive. A `409 POLICY_REVISION_STALE` proves the server created
   * no operation and no grant, so the operation is terminally `superseded_uncommitted` and a new
   * cycle may follow immediately. A `409 IDEMPOTENCY_CONFLICT` proves this identity was already used
   * with different bytes, which is terminal and never mutates or allocates.
   *
   * **Everything else is ambiguous**, including a timeout, a 5xx, and an aborted connection. §7.2:
   * an implementation that cannot prove undispatch must choose the ambiguous branch.
   */
  private classifyDispatchFailure(operationUuid: string, error: unknown): PrepareCycleOutcome {
    const code = (error as { readonly code?: unknown } | null)?.code
    const status = (error as { readonly status?: unknown } | null)?.status

    if (code === 'POLICY_REVISION_STALE') {
      runSerializedWrite(this.dependencies.database, () => {
        this.dependencies.preparation.markSupersededUncommitted(operationUuid)
      })
      this.log(formatDiagnostic('dispatch-superseded', { reason: 'policy_revision_stale' }))

      return { kind: 'superseded_uncommitted', operationUuid }
    }

    if (code === 'IDEMPOTENCY_CONFLICT') {
      runSerializedWrite(this.dependencies.database, () => {
        this.dependencies.preparation.markConflicted(operationUuid, 'idempotency_conflict')
      })
      this.log(formatDiagnostic('dispatch-conflicted', { reason: 'idempotency_conflict' }))

      return { kind: 'conflicted', operationUuid, reason: 'idempotency_conflict' }
    }

    if (status === 404 || code === 'DESKTOP_PREPARATION_UNAVAILABLE') {
      // The backend ships the capability disabled and answers 404. Nothing was created, so the
      // operation stays replayable rather than being burned — but it is not marked terminal either,
      // because "the feature is off right now" is not proof about a future attempt.
      this.log(formatDiagnostic('dispatch-unavailable', { reason: 'capability_absent' }))

      return { kind: 'unavailable', reason: 'capability_absent' }
    }

    runSerializedWrite(this.dependencies.database, () => {
      this.dependencies.preparation.markAmbiguous(operationUuid)
    })
    this.log(formatDiagnostic('dispatch-ambiguous', { classified: true }))

    return { kind: 'ambiguous', operationUuid }
  }
}
