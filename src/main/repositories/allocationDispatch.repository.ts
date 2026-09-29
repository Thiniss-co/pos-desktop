import { createHash } from 'node:crypto'
import type { SqliteDatabase } from '../database/connection'
import type { TopUpRequestBody } from '../services/allocationDeficit'

export type AllocationDispatchState = 'dispatched' | 'granted' | 'refused' | 'conflict' | 'invalid'

export interface AllocationDispatchOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly actorUserUuid: string
}

/** Categorical, sanitized evidence of the last answer. Never a token, payload or product name. */
export interface AllocationDispatchOutcome {
  readonly kind: 'response' | 'error' | 'ambiguous'
  readonly category?: string
  readonly backendCode?: string
  readonly httpStatus?: number
  readonly traceId?: string
  readonly reason?: string
}

export interface AllocationDispatchRow {
  readonly idempotencyKey: string
  readonly attemptKey: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly actorUserUuid: string
  readonly requestHash: string
  readonly requestBody: TopUpRequestBody
  readonly state: AllocationDispatchState
  readonly sendCount: number
  readonly ambiguousSendCount: number
  readonly lastOutcome: AllocationDispatchOutcome | null
  readonly retryNotBefore: string | null
  readonly createdAt: string
  readonly resolvedAt: string | null
}

interface DispatchTableRow {
  readonly idempotency_key: string
  readonly attempt_key: string
  readonly company_uuid: string
  readonly device_uuid: string
  readonly warehouse_uuid: string
  readonly actor_user_uuid: string
  readonly request_hash: string
  readonly request_body_json: string
  readonly state: AllocationDispatchState
  readonly send_count: number
  readonly ambiguous_send_count: number
  readonly last_outcome_json: string | null
  readonly retry_not_before: string | null
  readonly created_at: string
  readonly resolved_at: string | null
}

function mapRow(row: DispatchTableRow): AllocationDispatchRow {
  return {
    idempotencyKey: row.idempotency_key,
    attemptKey: row.attempt_key,
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    warehouseUuid: row.warehouse_uuid,
    actorUserUuid: row.actor_user_uuid,
    requestHash: row.request_hash,
    requestBody: JSON.parse(row.request_body_json) as TopUpRequestBody,
    state: row.state,
    sendCount: row.send_count,
    ambiguousSendCount: row.ambiguous_send_count,
    lastOutcome: row.last_outcome_json
      ? (JSON.parse(row.last_outcome_json) as AllocationDispatchOutcome)
      : null,
    retryNotBefore: row.retry_not_before,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

/** The exact bytes sent. The body is built deterministically, so equal requests hash equally. */
export function serializeTopUpRequest(body: TopUpRequestBody): {
  readonly json: string
  readonly hash: string
} {
  const json = JSON.stringify(body)
  return { json, hash: createHash('sha256').update(json).digest('hex') }
}

/**
 * Durable request-identity evidence for stock-allocation top-ups (migration 0016).
 *
 * A row is written before its request is dispatched and is never deleted. Its identity columns
 * and bytes are frozen by trigger; only the resolution columns move, and the schema refuses every
 * transition out of `granted`, `conflict` or `invalid`, and every transition out of `refused`
 * other than a re-send. This class performs the single write it is asked for and opens no
 * transaction of its own — callers own atomicity.
 */
export class AllocationDispatchRepository {
  constructor(private readonly database: SqliteDatabase) {}

  find(idempotencyKey: string): AllocationDispatchRow | null {
    const row = this.database
      .prepare('SELECT * FROM attempt_allocation_dispatches WHERE idempotency_key = ?')
      .get(idempotencyKey) as DispatchTableRow | undefined

    return row ? mapRow(row) : null
  }

  listForAttempt(attemptKey: string): readonly AllocationDispatchRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM attempt_allocation_dispatches
            WHERE attempt_key = ? ORDER BY created_at ASC, idempotency_key ASC`
        )
        .all(attemptKey) as DispatchTableRow[]
    ).map(mapRow)
  }

  /** Outstanding (`dispatched`) rows for one company + device, oldest first. */
  listOutstanding(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
  }): readonly AllocationDispatchRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM attempt_allocation_dispatches
            WHERE company_uuid = ? AND device_uuid = ? AND state = 'dispatched'
            ORDER BY created_at ASC, idempotency_key ASC`
        )
        .all(owner.companyUuid, owner.deviceUuid) as DispatchTableRow[]
    ).map(mapRow)
  }

  /**
   * Rows in the given states for one company + device, newest first and bounded. Read-only: used
   * by the Sync page's "needs attention" projection, which redacts per cashier itself.
   */
  listForOwnerByStates(
    owner: { readonly companyUuid: string; readonly deviceUuid: string },
    states: readonly AllocationDispatchState[],
    limit: number
  ): readonly AllocationDispatchRow[] {
    if (states.length === 0) {
      return []
    }

    return (
      this.database
        .prepare(
          `SELECT * FROM attempt_allocation_dispatches
            WHERE company_uuid = ? AND device_uuid = ?
              AND state IN (${states.map(() => '?').join(', ')})
            ORDER BY created_at DESC, idempotency_key ASC
            LIMIT ?`
        )
        .all(owner.companyUuid, owner.deviceUuid, ...states, limit) as DispatchTableRow[]
    ).map(mapRow)
  }

  /** Counts only — the Sync page shows how many need support, never their contents. */
  countByState(owner: {
    readonly companyUuid: string
    readonly deviceUuid: string
  }): Readonly<Record<AllocationDispatchState, number>> {
    const counts: Record<AllocationDispatchState, number> = {
      dispatched: 0,
      granted: 0,
      refused: 0,
      conflict: 0,
      invalid: 0
    }
    const rows = this.database
      .prepare(
        `SELECT state, COUNT(*) AS n FROM attempt_allocation_dispatches
          WHERE company_uuid = ? AND device_uuid = ? GROUP BY state`
      )
      .all(owner.companyUuid, owner.deviceUuid) as Array<{
      state: AllocationDispatchState
      n: number
    }>
    for (const row of rows) {
      counts[row.state] = row.n
    }
    return counts
  }

  /**
   * Inserts the identity of a request that is about to be sent, but only while the sale attempt it
   * belongs to is still `claimed` for this exact owner — re-checked in the same statement. Returns
   * `false` (nothing written) when the attempt is no longer claimed.
   */
  insertForClaimedAttempt(params: {
    readonly attemptKey: string
    readonly owner: AllocationDispatchOwner
    readonly body: TopUpRequestBody
    readonly createdAt: string
  }): boolean {
    const { json, hash } = serializeTopUpRequest(params.body)
    const result = this.database
      .prepare(
        `INSERT INTO attempt_allocation_dispatches (
           idempotency_key, attempt_key, company_uuid, device_uuid, warehouse_uuid,
           actor_user_uuid, request_hash, request_body_json, state, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?
          WHERE EXISTS (
            SELECT 1 FROM sale_attempts
             WHERE attempt_key = ? AND state = 'claimed'
               AND company_uuid = ? AND device_uuid = ? AND user_uuid = ?
          )`
      )
      .run(
        params.body.idempotency_key,
        params.attemptKey,
        params.owner.companyUuid,
        params.owner.deviceUuid,
        params.owner.warehouseUuid,
        params.owner.actorUserUuid,
        hash,
        json,
        params.createdAt,
        params.attemptKey,
        params.owner.companyUuid,
        params.owner.deviceUuid,
        params.owner.actorUserUuid
      )

    return result.changes === 1
  }

  /**
   * Committed immediately before each HTTP send. A `refused` row being re-sent returns to
   * `dispatched` here (the only transition out of `refused` the schema allows).
   */
  markSending(idempotencyKey: string, at: string): void {
    const result = this.database
      .prepare(
        `UPDATE attempt_allocation_dispatches
            SET send_count = send_count + 1, state = 'dispatched', resolved_at = NULL,
                retry_not_before = NULL
          WHERE idempotency_key = ? AND state IN ('dispatched','refused')`
      )
      .run(idempotencyKey)

    if (result.changes !== 1) {
      throw new Error(`Allocation dispatch cannot be sent from its current state (${at})`)
    }
  }

  /** A send whose server-side effect is unknown. The row stays `dispatched`. */
  recordAmbiguous(
    idempotencyKey: string,
    outcome: AllocationDispatchOutcome,
    retryNotBefore: string | null
  ): void {
    this.database
      .prepare(
        `UPDATE attempt_allocation_dispatches
            SET ambiguous_send_count = ambiguous_send_count + 1, last_outcome_json = ?,
                retry_not_before = ?
          WHERE idempotency_key = ? AND state = 'dispatched'`
      )
      .run(JSON.stringify(outcome), retryNotBefore, idempotencyKey)
  }

  /** A definitive answer that still proves nothing about this key. The row stays `dispatched`. */
  recordUnproven(
    idempotencyKey: string,
    outcome: AllocationDispatchOutcome,
    retryNotBefore: string | null
  ): void {
    this.database
      .prepare(
        `UPDATE attempt_allocation_dispatches
            SET last_outcome_json = ?, retry_not_before = ?
          WHERE idempotency_key = ? AND state = 'dispatched'`
      )
      .run(JSON.stringify(outcome), retryNotBefore, idempotencyKey)
  }

  resolve(
    idempotencyKey: string,
    state: Exclude<AllocationDispatchState, 'dispatched'>,
    outcome: AllocationDispatchOutcome,
    resolvedAt: string
  ): void {
    const result = this.database
      .prepare(
        `UPDATE attempt_allocation_dispatches
            SET state = ?, last_outcome_json = ?, resolved_at = ?, retry_not_before = NULL
          WHERE idempotency_key = ? AND state = 'dispatched'`
      )
      .run(state, JSON.stringify(outcome), resolvedAt, idempotencyKey)

    if (result.changes !== 1) {
      throw new Error('Allocation dispatch was not outstanding')
    }
  }
}
