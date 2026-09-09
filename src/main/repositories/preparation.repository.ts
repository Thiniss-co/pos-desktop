import type { SqliteDatabase } from '../database/connection'

/**
 * CP3 (plan §5.6, §7.2): durable local state for coordinated offline stock preparation.
 *
 * Every method here is a synchronous SQLite call intended to run inside a caller-owned
 * `runSerializedWrite` transaction. **No method opens a transaction of its own and none performs
 * HTTP** — §4 of the plan forbids HTTP inside a SQLite write transaction, and keeping the boundary
 * here rather than in the service is what makes that mechanically checkable.
 */

/** §7.2 step 2: why a candidate product was excluded from this cycle's eligible set. */
export type PrepareBlockedReason =
  | 'pending_upload'
  | 'uploading_ambiguous'
  | 'retryable_error'
  | 'terminal_conflict'
  | 'terminal_rejection'
  | 'dependency_scope_unknown'
  | 'owned_by_unresolved_operation'
  | 'policy_disabled'
  | 'blocked_by_unreleased_hold'

/** §5.6: the only operation states, and the only transitions between them. */
export type PrepareOperationState =
  | 'captured'
  | 'dispatching'
  | 'ambiguous'
  | 'discovered_pending_replay'
  | 'applied'
  | 'conflicted'
  | 'superseded_before_dispatch'
  | 'superseded_uncommitted'

export type PrepareOperationResult =
  'ready_72h' | 'partial_time' | 'partial_quantity' | 'blocked' | 'expired'

export type PrepareOutcomeReason =
  | 'full'
  | 'partial_cap'
  | 'partial_stock'
  | 'zero_at_target'
  | 'zero_cap'
  | 'zero_stock'
  | 'blocked_by_unreleased_hold'

export interface PrepareOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
}

export interface PrepareCycleCandidate {
  readonly productUuid: string
  readonly disposition: 'eligible' | 'blocked'
  readonly blockedReason: PrepareBlockedReason | null
}

export interface PrepareCycleDependency {
  readonly localQueueUuid: string
  readonly queueSequence: number
  readonly queueState: string
  readonly productUuid: string | null
  readonly allocationUuid: string | null
  readonly scopeKnown: boolean
}

export interface PrepareCycleRow {
  readonly cycleUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly requestedPolicyRevision: number
  readonly capturedQueueHighWater: number
  readonly state: 'captured' | 'frozen' | 'blocked' | 'superseded'
  readonly operationUuid: string | null
  readonly blockedReason: string | null
  readonly capturedAt: string
}

export interface PrepareOperationRow {
  readonly operationUuid: string
  readonly cycleUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly requestedPolicyRevision: number
  readonly canonicalRequestJson: string
  readonly requestHash: string
  readonly selectedProductUuids: readonly string[]
  readonly capturedSessionEpoch: number
  readonly state: PrepareOperationState
  readonly dispatchStartedAt: string | null
  readonly preparedAt: string | null
  readonly requiredDurationSeconds: number | null
  readonly requiredReadyUntil: string | null
  readonly authorityReadyUntil: string | null
  readonly result: PrepareOperationResult | null
  readonly primaryLimitingReason: string | null
  readonly appliedPolicyRevision: number | null
  readonly manifestJson: string | null
  readonly authorityReferencesJson: string | null
  readonly conflictReason: string | null
  readonly capturedAt: string
  readonly appliedAt: string | null
}

export interface PrepareOutcome {
  readonly productUuid: string
  readonly reason: PrepareOutcomeReason
  readonly grantedQuantityMilli: number
  readonly allocationUuid: string | null
  readonly issuedAt: string | null
  readonly consumeUntil: string | null
  readonly windowQualifiedHoldMilli: number
  readonly shortLivedHoldMilli: number
  readonly expiredHoldMilli: number
  readonly quarantinedHoldMilli: number
  readonly blockingAllocationUuids: readonly string[]
}

interface CycleDbRow {
  readonly cycle_uuid: string
  readonly company_uuid: string
  readonly device_uuid: string
  readonly warehouse_uuid: string
  readonly requested_policy_revision: number
  readonly captured_queue_high_water: number
  readonly state: 'captured' | 'frozen' | 'blocked' | 'superseded'
  readonly operation_uuid: string | null
  readonly blocked_reason: string | null
  readonly captured_at: string
}

interface OperationDbRow {
  readonly operation_uuid: string
  readonly cycle_uuid: string
  readonly company_uuid: string
  readonly device_uuid: string
  readonly warehouse_uuid: string
  readonly requested_policy_revision: number
  readonly canonical_request_json: string
  readonly request_hash: string
  readonly selected_product_uuids_json: string
  readonly captured_session_epoch: number
  readonly state: PrepareOperationState
  readonly dispatch_started_at: string | null
  readonly prepared_at: string | null
  readonly required_duration_seconds: number | null
  readonly required_ready_until: string | null
  readonly authority_ready_until: string | null
  readonly result: PrepareOperationResult | null
  readonly primary_limiting_reason: string | null
  readonly applied_policy_revision: number | null
  readonly manifest_json: string | null
  readonly authority_references_json: string | null
  readonly conflict_reason: string | null
  readonly captured_at: string
  readonly applied_at: string | null
}

interface OutcomeDbRow {
  readonly product_uuid: string
  readonly reason: PrepareOutcomeReason
  readonly granted_quantity_milli: number
  readonly allocation_uuid: string | null
  readonly issued_at: string | null
  readonly consume_until: string | null
  readonly window_qualified_hold_milli: number
  readonly short_lived_hold_milli: number
  readonly expired_hold_milli: number
  readonly quarantined_hold_milli: number
  readonly blocking_allocation_uuids_json: string | null
}

export class PreparationRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => string
  ) {}

  /**
   * §7.2 step 1: the bounded capture boundary.
   *
   * Read inside the same transaction that persists the cycle, so a queue row committed while the
   * cycle is being captured either lands below this mark and is captured, or lands above it and
   * belongs to the next cycle. There is no third possibility, which is exactly what stops
   * continuous selling from starving a cycle.
   */
  currentQueueHighWater(): number {
    const row = this.database
      .prepare<[], { high_water: number }>(
        `SELECT COALESCE(MAX(queue_sequence), 0) AS high_water FROM sync_queue`
      )
      .get()

    return row?.high_water ?? 0
  }

  /**
   * Persist one captured cycle with its partition and its dependency join.
   *
   * The blocked set is stored here as cycle state, never as part of an outbound request (§7.2
   * step 3): it is what the UI reports as held and what a later cycle re-evaluates.
   */
  captureCycle(params: {
    readonly cycleUuid: string
    readonly owner: PrepareOwner
    readonly requestedPolicyRevision: number
    readonly capturedQueueHighWater: number
    readonly candidates: readonly PrepareCycleCandidate[]
    readonly dependencies: readonly PrepareCycleDependency[]
  }): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `INSERT INTO prepare_cycles (
           cycle_uuid, company_uuid, device_uuid, warehouse_uuid, requested_policy_revision,
           captured_queue_high_water, state, captured_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'captured', ?, ?)`
      )
      .run(
        params.cycleUuid,
        params.owner.companyUuid,
        params.owner.deviceUuid,
        params.owner.warehouseUuid,
        params.requestedPolicyRevision,
        params.capturedQueueHighWater,
        timestamp,
        timestamp
      )

    const insertCandidate = this.database.prepare(
      `INSERT INTO prepare_cycle_products (cycle_uuid, product_uuid, disposition, blocked_reason)
       VALUES (?, ?, ?, ?)`
    )

    for (const candidate of params.candidates) {
      insertCandidate.run(
        params.cycleUuid,
        candidate.productUuid,
        candidate.disposition,
        candidate.blockedReason
      )
    }

    const insertDependency = this.database.prepare(
      `INSERT OR IGNORE INTO prepare_cycle_dependencies (
         cycle_uuid, local_queue_uuid, queue_sequence, queue_state, product_uuid,
         allocation_uuid, scope_known
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    for (const dependency of params.dependencies) {
      insertDependency.run(
        params.cycleUuid,
        dependency.localQueueUuid,
        dependency.queueSequence,
        dependency.queueState,
        dependency.productUuid,
        dependency.allocationUuid,
        dependency.scopeKnown ? 1 : 0
      )
    }
  }

  /** §7.2 step 4: an empty eligible set terminates the cycle and dispatches nothing. */
  markCycleBlocked(cycleUuid: string, reason: string): void {
    this.database
      .prepare(
        `UPDATE prepare_cycles SET state = 'blocked', blocked_reason = ?, updated_at = ?
         WHERE cycle_uuid = ? AND state = 'captured'`
      )
      .run(reason, this.now(), cycleUuid)
  }

  /**
   * §7.2 step 4: freeze the operation.
   *
   * From this commit onward the `operation_uuid`, the canonical bytes and the derived hash are
   * immutable — enforced by a database trigger, not by convention, because the whole safety
   * argument for ambiguous retry is that these bytes cannot have changed since dispatch.
   */
  freezeOperation(params: {
    readonly cycleUuid: string
    readonly operationUuid: string
    readonly owner: PrepareOwner
    readonly requestedPolicyRevision: number
    readonly canonicalRequestJson: string
    readonly requestHash: string
    readonly selectedProductUuids: readonly string[]
    readonly capturedSessionEpoch: number
  }): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `INSERT INTO prepare_operations (
           operation_uuid, cycle_uuid, company_uuid, device_uuid, warehouse_uuid,
           requested_policy_revision, canonical_request_json, request_hash,
           selected_product_uuids_json, captured_session_epoch, state, captured_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)`
      )
      .run(
        params.operationUuid,
        params.cycleUuid,
        params.owner.companyUuid,
        params.owner.deviceUuid,
        params.owner.warehouseUuid,
        params.requestedPolicyRevision,
        params.canonicalRequestJson,
        params.requestHash,
        JSON.stringify([...params.selectedProductUuids]),
        params.capturedSessionEpoch,
        timestamp,
        timestamp
      )

    this.database
      .prepare(
        `UPDATE prepare_cycles SET state = 'frozen', operation_uuid = ?, frozen_at = ?, updated_at = ?
         WHERE cycle_uuid = ?`
      )
      .run(params.operationUuid, timestamp, timestamp, params.cycleUuid)
  }

  /**
   * Record that dispatch is about to begin, **before** the request leaves.
   *
   * §7.2 makes ambiguity the default classification: an implementation that cannot prove a request
   * never left must treat it as ambiguous. Writing this first is what lets a restart distinguish
   * "persisted but provably never sent" from "may have reached Laravel", and it is deliberately a
   * separate committed write rather than an in-memory flag — a flag does not survive process death,
   * which is precisely the case that matters.
   */
  markDispatching(operationUuid: string): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `UPDATE prepare_operations
         SET state = 'dispatching', dispatch_started_at = ?, updated_at = ?
         WHERE operation_uuid = ? AND state = 'captured'`
      )
      .run(timestamp, timestamp, operationUuid)
  }

  markAmbiguous(operationUuid: string): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `UPDATE prepare_operations SET state = 'ambiguous', updated_at = ?
         WHERE operation_uuid = ? AND state IN ('captured','dispatching','ambiguous')`
      )
      .run(timestamp, operationUuid)
  }

  /**
   * §5.6: the server proved no operation and no grant were created — a `409 POLICY_REVISION_STALE`
   * before anything committed. Terminal, and honest: there is genuinely nothing on the server to
   * reconcile, so a new cycle may follow immediately.
   */
  markSupersededUncommitted(operationUuid: string): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `UPDATE prepare_operations SET state = 'superseded_uncommitted', updated_at = ?
         WHERE operation_uuid = ? AND state IN ('captured','dispatching')`
      )
      .run(timestamp, operationUuid)
  }

  /**
   * §7.2: the operation was persisted but **provably** never dispatched.
   *
   * Guarded on `dispatch_started_at IS NULL` in SQL rather than trusted from the caller. "Proven
   * undispatched" has to mean proven from durable state, and the whole point of the ambiguous
   * default is that a caller's belief is not proof.
   */
  markSupersededBeforeDispatch(operationUuid: string): boolean {
    const timestamp = this.now()
    const result = this.database
      .prepare(
        `UPDATE prepare_operations SET state = 'superseded_before_dispatch', updated_at = ?
         WHERE operation_uuid = ? AND state = 'captured' AND dispatch_started_at IS NULL`
      )
      .run(timestamp, operationUuid)

    return result.changes === 1
  }

  markConflicted(operationUuid: string, reason: string): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `UPDATE prepare_operations SET state = 'conflicted', conflict_reason = ?, updated_at = ?
         WHERE operation_uuid = ? AND state NOT IN (
           'applied','conflicted','superseded_before_dispatch','superseded_uncommitted'
         )`
      )
      .run(reason, timestamp, operationUuid)
  }

  /**
   * §5.6 "partial discovery": at least one linked grant was validated and ingested, but the §5.4
   * completeness predicate is not yet satisfied.
   *
   * The ingested grant is spendable — that fact lives in `stock_allocations` and is unaffected by
   * this. What this records is that the *operation* is still open: it may not be closed, no new
   * operation may be created for its selected products, and readiness reports it as unresolved
   * rather than successful.
   */
  recordDiscoveredGrant(params: {
    readonly operationUuid: string
    readonly allocationUuid: string
    readonly productUuid: string
  }): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO prepare_operation_discovered_grants (
           operation_uuid, allocation_uuid, product_uuid, discovered_at
         ) VALUES (?, ?, ?, ?)`
      )
      .run(params.operationUuid, params.allocationUuid, params.productUuid, this.now())

    this.database
      .prepare(
        `UPDATE prepare_operations SET state = 'discovered_pending_replay', updated_at = ?
         WHERE operation_uuid = ? AND state IN ('dispatching','ambiguous','discovered_pending_replay')`
      )
      .run(this.now(), params.operationUuid)
  }

  discoveredGrantUuids(operationUuid: string): readonly string[] {
    return this.database
      .prepare<[string], { allocation_uuid: string }>(
        `SELECT allocation_uuid FROM prepare_operation_discovered_grants
         WHERE operation_uuid = ? ORDER BY allocation_uuid`
      )
      .all(operationUuid)
      .map((row) => row.allocation_uuid)
  }

  /**
   * §5.4 item 6: apply the complete decision atomically.
   *
   * Every per-product outcome, the manifest, and the terminal state commit in one transaction — the
   * caller's — or none of them does. A torn application would leave the operation `applied` with an
   * incomplete decision, which is precisely the state the completeness predicate exists to make
   * unreachable, so the schema additionally refuses `applied` without a manifest.
   */
  applyDecision(params: {
    readonly operationUuid: string
    readonly preparedAt: string
    readonly requiredDurationSeconds: number
    readonly requiredReadyUntil: string
    readonly authorityReadyUntil: string
    readonly result: PrepareOperationResult
    readonly primaryLimitingReason: string
    readonly appliedPolicyRevision: number | null
    readonly manifestJson: string
    readonly authorityReferencesJson: string
    readonly outcomes: readonly PrepareOutcome[]
  }): void {
    const timestamp = this.now()
    const insertOutcome = this.database.prepare(
      `INSERT OR REPLACE INTO prepare_operation_outcomes (
         operation_uuid, product_uuid, reason, granted_quantity_milli, allocation_uuid,
         issued_at, consume_until, window_qualified_hold_milli, short_lived_hold_milli,
         expired_hold_milli, quarantined_hold_milli, blocking_allocation_uuids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const outcome of params.outcomes) {
      insertOutcome.run(
        params.operationUuid,
        outcome.productUuid,
        outcome.reason,
        outcome.grantedQuantityMilli,
        outcome.allocationUuid,
        outcome.issuedAt,
        outcome.consumeUntil,
        outcome.windowQualifiedHoldMilli,
        outcome.shortLivedHoldMilli,
        outcome.expiredHoldMilli,
        outcome.quarantinedHoldMilli,
        JSON.stringify([...outcome.blockingAllocationUuids])
      )
    }

    this.database
      .prepare(
        `UPDATE prepare_operations SET
           state = 'applied',
           prepared_at = ?,
           required_duration_seconds = ?,
           required_ready_until = ?,
           authority_ready_until = ?,
           result = ?,
           primary_limiting_reason = ?,
           applied_policy_revision = ?,
           manifest_json = ?,
           authority_references_json = ?,
           applied_at = ?,
           updated_at = ?
         WHERE operation_uuid = ? AND state NOT IN (
           'applied','conflicted','superseded_before_dispatch','superseded_uncommitted'
         )`
      )
      .run(
        params.preparedAt,
        params.requiredDurationSeconds,
        params.requiredReadyUntil,
        params.authorityReadyUntil,
        params.result,
        params.primaryLimitingReason,
        params.appliedPolicyRevision,
        params.manifestJson,
        params.authorityReferencesJson,
        timestamp,
        timestamp,
        params.operationUuid
      )
  }

  findOperation(operationUuid: string): PrepareOperationRow | null {
    const row = this.database
      .prepare<[string], OperationDbRow>(
        `SELECT * FROM prepare_operations WHERE operation_uuid = ?`
      )
      .get(operationUuid)

    return row ? this.toOperation(row) : null
  }

  outcomes(operationUuid: string): readonly PrepareOutcome[] {
    return this.database
      .prepare<[string], OutcomeDbRow>(
        `SELECT * FROM prepare_operation_outcomes WHERE operation_uuid = ? ORDER BY product_uuid`
      )
      .all(operationUuid)
      .map((row) => ({
        productUuid: row.product_uuid,
        reason: row.reason,
        grantedQuantityMilli: row.granted_quantity_milli,
        allocationUuid: row.allocation_uuid,
        issuedAt: row.issued_at,
        consumeUntil: row.consume_until,
        windowQualifiedHoldMilli: row.window_qualified_hold_milli,
        shortLivedHoldMilli: row.short_lived_hold_milli,
        expiredHoldMilli: row.expired_hold_milli,
        quarantinedHoldMilli: row.quarantined_hold_milli,
        blockingAllocationUuids: row.blocking_allocation_uuids_json
          ? (JSON.parse(row.blocking_allocation_uuids_json) as string[])
          : []
      }))
  }

  /**
   * Operations that still own their selected products.
   *
   * §5.6 forbids creating a new operation for a product already selected by an `ambiguous` or
   * `discovered_pending_replay` operation — and `captured`/`dispatching` are equally unresolved, so
   * all four are returned. This is the query that makes "no duplicate grant from repeated clicks"
   * a checked property rather than a timing accident.
   */
  unresolvedOperations(owner: PrepareOwner): readonly PrepareOperationRow[] {
    return this.database
      .prepare<[string, string, string], OperationDbRow>(
        `SELECT * FROM prepare_operations
         WHERE company_uuid = ? AND device_uuid = ? AND warehouse_uuid = ?
           AND state IN ('captured','dispatching','ambiguous','discovered_pending_replay')
         ORDER BY captured_at ASC`
      )
      .all(owner.companyUuid, owner.deviceUuid, owner.warehouseUuid)
      .map((row) => this.toOperation(row))
  }

  /** Products currently owned by an unresolved operation, so a new cycle must block them. */
  productsOwnedByUnresolvedOperations(owner: PrepareOwner): ReadonlySet<string> {
    const owned = new Set<string>()

    for (const operation of this.unresolvedOperations(owner)) {
      for (const productUuid of operation.selectedProductUuids) {
        owned.add(productUuid)
      }
    }

    return owned
  }

  /** The most recently applied operation, which is what live readiness is projected from. */
  latestAppliedOperation(owner: PrepareOwner): PrepareOperationRow | null {
    const row = this.database
      .prepare<[string, string, string], OperationDbRow>(
        `SELECT * FROM prepare_operations
         WHERE company_uuid = ? AND device_uuid = ? AND warehouse_uuid = ? AND state = 'applied'
         ORDER BY prepared_at DESC, applied_at DESC LIMIT 1`
      )
      .get(owner.companyUuid, owner.deviceUuid, owner.warehouseUuid)

    return row ? this.toOperation(row) : null
  }

  findCycle(cycleUuid: string): PrepareCycleRow | null {
    const row = this.database
      .prepare<[string], CycleDbRow>(`SELECT * FROM prepare_cycles WHERE cycle_uuid = ?`)
      .get(cycleUuid)

    return row
      ? {
          cycleUuid: row.cycle_uuid,
          companyUuid: row.company_uuid,
          deviceUuid: row.device_uuid,
          warehouseUuid: row.warehouse_uuid,
          requestedPolicyRevision: row.requested_policy_revision,
          capturedQueueHighWater: row.captured_queue_high_water,
          state: row.state,
          operationUuid: row.operation_uuid,
          blockedReason: row.blocked_reason,
          capturedAt: row.captured_at
        }
      : null
  }

  cycleProducts(cycleUuid: string): readonly PrepareCycleCandidate[] {
    return this.database
      .prepare<
        [string],
        { product_uuid: string; disposition: 'eligible' | 'blocked'; blocked_reason: string | null }
      >(
        `SELECT product_uuid, disposition, blocked_reason FROM prepare_cycle_products
         WHERE cycle_uuid = ? ORDER BY product_uuid`
      )
      .all(cycleUuid)
      .map((row) => ({
        productUuid: row.product_uuid,
        disposition: row.disposition,
        blockedReason: row.blocked_reason as PrepareBlockedReason | null
      }))
  }

  private toOperation(row: OperationDbRow): PrepareOperationRow {
    return {
      operationUuid: row.operation_uuid,
      cycleUuid: row.cycle_uuid,
      companyUuid: row.company_uuid,
      deviceUuid: row.device_uuid,
      warehouseUuid: row.warehouse_uuid,
      requestedPolicyRevision: row.requested_policy_revision,
      canonicalRequestJson: row.canonical_request_json,
      requestHash: row.request_hash,
      selectedProductUuids: JSON.parse(row.selected_product_uuids_json) as string[],
      capturedSessionEpoch: row.captured_session_epoch,
      state: row.state,
      dispatchStartedAt: row.dispatch_started_at,
      preparedAt: row.prepared_at,
      requiredDurationSeconds: row.required_duration_seconds,
      requiredReadyUntil: row.required_ready_until,
      authorityReadyUntil: row.authority_ready_until,
      result: row.result,
      primaryLimitingReason: row.primary_limiting_reason,
      appliedPolicyRevision: row.applied_policy_revision,
      manifestJson: row.manifest_json,
      authorityReferencesJson: row.authority_references_json,
      conflictReason: row.conflict_reason,
      capturedAt: row.captured_at,
      appliedAt: row.applied_at
    }
  }
}
