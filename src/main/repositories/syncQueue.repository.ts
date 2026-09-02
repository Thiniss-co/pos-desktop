import {
  type SyncQueueState,
  isSyncQueueState,
  isSyncQueueTransitionAllowed
} from '@shared/constants/syncQueueStates'
import {
  SYNC_FAILURE_PAGE_DEFAULT_SIZE,
  SYNC_FAILURE_PAGE_MAX_SIZE,
  type SyncCounts,
  type SyncFailure,
  type SyncFailureCursor,
  type SyncFailurePage,
  type SyncStatus
} from '@shared/contracts/sync.contract'
import type { SqliteDatabase } from '../database/connection'

export interface NewSyncQueueItem {
  readonly localQueueUuid: string
  readonly aggregateType: string
  readonly localAggregateUuid: string
  readonly operation: string
  readonly payloadJson: string
  readonly payloadHash: string
  readonly idempotencyKey: string
  readonly dependencyQueueUuid?: string
}

interface SyncQueueRow {
  readonly state: string
}

/**
 * The company/device pair an upload is allowed to act for. Ownership is enforced in SQL rather than
 * left to the caller: a queued invoice belonging to another company or another device must never be
 * uploaded under this device's token, and a fail-closed query cannot be forgotten the way a caller's
 * `if` can. Cross-*user* is deliberately not part of this — the backend attributes an upload from
 * the immutable shift row, so a colleague's queued sale is legitimately uploadable from this till.
 */
export interface SyncQueueUploadOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

/** One invoice-upload row leased for dispatch. */
export interface ClaimedInvoiceUpload {
  readonly localQueueUuid: string
  readonly invoiceLocalUuid: string
  readonly payloadJson: string
  readonly payloadHash: string
  readonly idempotencyKey: string
  /** Dispatch count *including* this claim; feeds calculateRetryDelayMs on failure. */
  readonly attemptCount: number
}

/** Diagnostic detail persisted on a non-success outcome. Never used to make a decision. */
export interface SyncQueueErrorDetails {
  readonly backendCode?: string
  readonly httpStatus?: number
  readonly traceId?: string
  readonly message?: string
}

interface ClaimCandidateRow {
  readonly local_queue_uuid: string
  readonly local_aggregate_uuid: string
  readonly payload_json: string
  readonly payload_hash: string
  readonly idempotency_key: string
  readonly attempt_count: number
}

interface ExpiredLeaseRow {
  readonly local_queue_uuid: string
  readonly upload_lease_at: string | null
}

function serializeErrorDetails(details: SyncQueueErrorDetails | undefined): string | null {
  if (!details) {
    return null
  }

  const entries = Object.entries(details).filter(([, value]) => value !== undefined)

  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null
}

/**
 * The immutable queued upload evidence for one local invoice. Read-only: Phase 3F has no upload
 * worker and no production consumer of these rows (plan §7f) — they exist so the completion path
 * can prove its own post-write invariants and so a committed-result replay can re-verify that the
 * queued payload was never mutated (plan §1.6 item 3).
 */
export interface SyncQueueUploadRow {
  readonly localQueueUuid: string
  readonly payloadJson: string
  readonly payloadHash: string
}

interface SyncQueueUploadDbRow {
  readonly local_queue_uuid: string
  readonly payload_json: string
  readonly payload_hash: string
}

interface UploadFailureDbRow {
  readonly local_queue_uuid: string
  readonly state: string
  readonly last_error_code: string | null
  readonly last_error_details: string | null
  readonly created_at: string
  readonly invoice_local_uuid: string | null
  readonly offline_number: string | null
  readonly grand_total_amount: number | null
  readonly currency: string | null
  readonly currency_exponent: number | null
  readonly sold_at: string | null
  readonly user_uuid: string | null
  readonly shift_uuid: string | null
}

/**
 * Reads the two renderer-safe fields out of the persisted `last_error_details` JSON.
 *
 * Anything unparseable degrades to nulls rather than throwing: a malformed diagnostic blob must not
 * make a real failed sale invisible to the operator reviewing it.
 */
function readErrorDetails(raw: string | null): {
  readonly traceId: string | null
  readonly message: string | null
  readonly backendCode: string | null
} {
  const empty = { traceId: null, message: null, backendCode: null }

  if (raw === null) {
    return empty
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (typeof parsed !== 'object' || parsed === null) {
      return empty
    }

    const record = parsed as Record<string, unknown>

    return {
      traceId: typeof record.traceId === 'string' ? record.traceId : null,
      message: typeof record.message === 'string' ? record.message : null,
      backendCode: typeof record.backendCode === 'string' ? record.backendCode : null
    }
  } catch {
    return empty
  }
}

interface SyncCountRow {
  readonly state: SyncQueueState
  readonly count: number
}

interface UpdateResult {
  readonly changes: number
}

export class SyncQueueRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  enqueue(item: NewSyncQueueItem): void {
    const timestamp = this.now()

    this.database
      .prepare(
        `
          INSERT INTO sync_queue (
            local_queue_uuid, aggregate_type, local_aggregate_uuid, operation, payload_json, payload_hash,
            idempotency_key, state, dependency_queue_uuid, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `
      )
      .run(
        item.localQueueUuid,
        item.aggregateType,
        item.localAggregateUuid,
        item.operation,
        item.payloadJson,
        item.payloadHash,
        item.idempotencyKey,
        item.dependencyQueueUuid ?? null,
        timestamp,
        timestamp
      )
  }

  /**
   * Every `aggregate_type='invoice'`/`operation='upload'` row queued for one local invoice.
   * Deliberately returns **all** matches rather than a `LIMIT 1` row, so a caller asserting the
   * plan's "exactly one invoice/upload queue row" invariant sees a duplicate instead of silently
   * reading the first of several.
   */
  invoiceUploadRowsFor(localAggregateUuid: string): readonly SyncQueueUploadRow[] {
    const rows = this.database
      .prepare(
        `
          SELECT local_queue_uuid, payload_json, payload_hash
          FROM sync_queue
          WHERE aggregate_type = 'invoice'
            AND operation = 'upload'
            AND local_aggregate_uuid = ?
          ORDER BY local_queue_uuid ASC
        `
      )
      .all(localAggregateUuid) as SyncQueueUploadDbRow[]

    return rows.map((row) => ({
      localQueueUuid: row.local_queue_uuid,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash
    }))
  }

  transition(localQueueUuid: string, nextState: SyncQueueState): void {
    this.database.transaction(() => {
      const row = this.database
        .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
        .get(localQueueUuid) as SyncQueueRow | undefined

      if (!row || !isSyncQueueState(row.state)) {
        throw new Error('Sync queue item was not found')
      }

      if (!isSyncQueueTransitionAllowed(row.state, nextState)) {
        throw new Error(`Sync queue transition from ${row.state} to ${nextState} is not allowed`)
      }

      const result = this.database
        .prepare(
          'UPDATE sync_queue SET state = ?, updated_at = ? WHERE local_queue_uuid = ? AND state = ?'
        )
        .run(nextState, this.now(), localQueueUuid, row.state) as UpdateResult

      if (result.changes !== 1) {
        throw new Error('Sync queue item changed before its transition could be committed')
      }
    })()
  }

  /**
   * Leases the next dispatchable invoice upload, or returns null when there is nothing due.
   *
   * One transaction does select-then-claim so two callers cannot lease the same row; the UPDATE is
   * additionally guarded on `state = 'pending'`. Ordering is explicit and total
   * (`created_at`, then `local_queue_uuid`) so the drain order is deterministic and a tie cannot
   * depend on physical row order.
   *
   * `local_invoices.sync_status` and `sync_attempts` move in the same transaction as the queue row:
   * the two must never disagree about whether an upload is in flight.
   */
  claimNextInvoiceUpload(
    owner: SyncQueueUploadOwner,
    nowIso: string = this.now()
  ): ClaimedInvoiceUpload | null {
    return this.database.transaction((): ClaimedInvoiceUpload | null => {
      const candidate = this.database
        .prepare(
          `
            SELECT q.local_queue_uuid, q.local_aggregate_uuid, q.payload_json, q.payload_hash,
                   q.idempotency_key, q.attempt_count
            FROM sync_queue q
            JOIN local_invoices i ON i.local_uuid = q.local_aggregate_uuid
            WHERE q.aggregate_type = 'invoice'
              AND q.operation = 'upload'
              AND q.state = 'pending'
              AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
              AND i.company_uuid = ?
              AND i.device_uuid = ?
            ORDER BY q.created_at ASC, q.local_queue_uuid ASC
            LIMIT 1
          `
        )
        .get(nowIso, owner.companyUuid, owner.deviceUuid) as ClaimCandidateRow | undefined

      if (!candidate) {
        return null
      }

      const attemptCount = candidate.attempt_count + 1
      const claimed = this.database
        .prepare(
          `
            UPDATE sync_queue
            SET state = 'uploading', attempt_count = ?, upload_lease_at = ?, updated_at = ?
            WHERE local_queue_uuid = ? AND state = 'pending'
          `
        )
        .run(attemptCount, nowIso, nowIso, candidate.local_queue_uuid) as UpdateResult

      if (claimed.changes !== 1) {
        throw new Error('Sync queue item changed before it could be claimed for upload')
      }

      this.database
        .prepare(
          `
            UPDATE local_invoices
            SET sync_status = 'uploading', sync_attempts = sync_attempts + 1, updated_at = ?
            WHERE local_uuid = ?
          `
        )
        .run(nowIso, candidate.local_aggregate_uuid)

      return {
        localQueueUuid: candidate.local_queue_uuid,
        invoiceLocalUuid: candidate.local_aggregate_uuid,
        payloadJson: candidate.payload_json,
        payloadHash: candidate.payload_hash,
        idempotencyKey: candidate.idempotency_key,
        attemptCount
      }
    })()
  }

  /**
   * Frees rows left `uploading` by a crash or a killed process.
   *
   * The reclaim target is **`retryable_error`, not `pending`** — `uploading -> pending` is not a
   * legal transition, and going through `retryable_error` is also the honest description of what
   * happened: the dispatch did not complete. Backoff then returns the row to `pending` on its own
   * schedule. Reclaiming is only safe because re-sending carries the same idempotency key, so a
   * request that did reach the server converges on its duplicate answer instead of duplicating.
   */
  reclaimExpiredUploadLeases(
    nowIso: string = this.now(),
    isExpired: (leaseClaimedAt: string | null, now: Date) => boolean
  ): readonly string[] {
    return this.database.transaction((): readonly string[] => {
      const rows = this.database
        .prepare(
          `
            SELECT local_queue_uuid, upload_lease_at
            FROM sync_queue
            WHERE aggregate_type = 'invoice' AND operation = 'upload' AND state = 'uploading'
            ORDER BY local_queue_uuid ASC
          `
        )
        .all() as ExpiredLeaseRow[]
      const now = new Date(nowIso)
      const reclaimed: string[] = []

      for (const row of rows) {
        if (!isExpired(row.upload_lease_at, now)) {
          continue
        }

        this.failUpload(row.local_queue_uuid, 'retryable_error', nowIso, {
          errorCode: 'upload_lease_expired',
          details: { message: 'The upload lease expired before an answer was recorded.' },
          nextAttemptAt: nowIso
        })
        reclaimed.push(row.local_queue_uuid)
      }

      return reclaimed
    })()
  }

  /** `uploading -> synced`. The invoice row is written by LocalSaleRepository in the same txn. */
  markUploadSynced(localQueueUuid: string, nowIso: string = this.now()): void {
    this.updateGuarded(
      localQueueUuid,
      'uploading',
      `
        UPDATE sync_queue
        SET state = 'synced', upload_lease_at = NULL, next_attempt_at = NULL,
            last_error_code = NULL, last_error_details = NULL, updated_at = ?
        WHERE local_queue_uuid = ? AND state = 'uploading'
      `,
      [nowIso, localQueueUuid]
    )
  }

  /**
   * `uploading -> retryable_error | conflict | rejected`.
   *
   * `next_attempt_at` is only meaningful for `retryable_error`; the two terminal states leave it
   * null so nothing can reschedule them by accident.
   */
  failUpload(
    localQueueUuid: string,
    state: Extract<SyncQueueState, 'retryable_error' | 'conflict' | 'rejected'>,
    nowIso: string = this.now(),
    failure: {
      readonly errorCode: string
      readonly details?: SyncQueueErrorDetails
      readonly nextAttemptAt?: string
    }
  ): void {
    this.updateGuarded(
      localQueueUuid,
      'uploading',
      `
        UPDATE sync_queue
        SET state = ?, upload_lease_at = NULL, next_attempt_at = ?,
            last_error_code = ?, last_error_details = ?, updated_at = ?
        WHERE local_queue_uuid = ? AND state = 'uploading'
      `,
      [
        state,
        state === 'retryable_error' ? (failure.nextAttemptAt ?? nowIso) : null,
        failure.errorCode,
        serializeErrorDetails(failure.details),
        nowIso,
        localQueueUuid
      ]
    )
  }

  /**
   * `retryable_error -> pending`, only once the backoff deadline has passed. Returns the rows
   * released so a caller can log how many became eligible rather than guessing.
   */
  releaseDueRetries(nowIso: string = this.now()): readonly string[] {
    return this.database.transaction((): readonly string[] => {
      const rows = this.database
        .prepare(
          `
            SELECT local_queue_uuid
            FROM sync_queue
            WHERE aggregate_type = 'invoice' AND operation = 'upload'
              AND state = 'retryable_error'
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC, local_queue_uuid ASC
          `
        )
        .all(nowIso) as { readonly local_queue_uuid: string }[]

      for (const row of rows) {
        this.updateGuarded(
          row.local_queue_uuid,
          'retryable_error',
          `
            UPDATE sync_queue
            SET state = 'pending', updated_at = ?
            WHERE local_queue_uuid = ? AND state = 'retryable_error'
          `,
          [nowIso, row.local_queue_uuid]
        )
      }

      return rows.map((row) => row.local_queue_uuid)
    })()
  }

  /**
   * The terminal `conflict` / `rejected` invoice uploads for one company+device, oldest first.
   *
   * Three properties are load-bearing:
   *
   * 1. **Ownership is enforced in SQL**, exactly as `claimNextInvoiceUpload` does it — the caller
   *    cannot forget it, and another device's failed sale is unreachable rather than merely
   *    unselected. Cross-*user* rows on this device stay visible: a delayed upload is device-owned
   *    and the backend attributes it from the immutable shift, so a colleague's stranded sale is
   *    exactly what this till's operator needs to see.
   * 2. **Keyset, not offset.** The tuple is the drain order (`created_at`, then `local_queue_uuid`),
   *    so a row reaching a terminal state between two pages cannot make the reader skip or repeat a
   *    real sale.
   * 3. **`local_invoices` is LEFT JOINed.** A queue row whose invoice is missing stays listed with
   *    null invoice fields — visible and diagnosable — rather than silently disappearing.
   *
   * This is a pure read: it opens no transaction, writes nothing, and never touches the network.
   */
  listUploadFailures(
    owner: SyncQueueUploadOwner,
    cursor: SyncFailureCursor | null = null,
    limit: number = SYNC_FAILURE_PAGE_DEFAULT_SIZE
  ): SyncFailurePage {
    const size = Math.min(Math.max(Math.trunc(limit), 1), SYNC_FAILURE_PAGE_MAX_SIZE)
    const parameters: unknown[] = [owner.companyUuid, owner.deviceUuid]
    let keyset = ''

    if (cursor !== null) {
      // Strictly after the cursor in the same total order the ORDER BY establishes.
      keyset = ' AND (q.created_at > ? OR (q.created_at = ? AND q.local_queue_uuid > ?))'
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.localQueueUuid)
    }

    // One extra row decides whether another page exists, without a second COUNT query.
    parameters.push(size + 1)

    const rows = this.database
      .prepare(
        `
          SELECT q.local_queue_uuid, q.state, q.last_error_code, q.last_error_details, q.created_at,
                 i.local_uuid AS invoice_local_uuid, i.offline_number, i.grand_total_amount,
                 i.currency, i.currency_exponent, i.sold_at, i.user_uuid, i.shift_uuid
          FROM sync_queue q
          LEFT JOIN local_invoices i ON i.local_uuid = q.local_aggregate_uuid
          WHERE q.aggregate_type = 'invoice'
            AND q.operation = 'upload'
            AND q.state IN ('conflict', 'rejected')
            AND i.company_uuid = ?
            AND i.device_uuid = ?${keyset}
          ORDER BY q.created_at ASC, q.local_queue_uuid ASC
          LIMIT ?
        `
      )
      .all(...parameters) as UploadFailureDbRow[]

    const page = rows.slice(0, size)
    const items: SyncFailure[] = page.map((row) => {
      const details = readErrorDetails(row.last_error_details)

      return {
        localQueueUuid: row.local_queue_uuid,
        invoiceLocalUuid: row.invoice_local_uuid,
        offlineNumber: row.offline_number,
        totalAmount: row.grand_total_amount,
        currency: row.currency,
        currencyExponent: row.currency_exponent,
        soldAt: row.sold_at,
        cashierUuid: row.user_uuid,
        shiftUuid: row.shift_uuid,
        // The CHECK constraint pins this to the two terminal states the WHERE clause selected.
        state: row.state === 'conflict' ? 'conflict' : 'rejected',
        backendCode: row.last_error_code ?? details.backendCode,
        message: details.message,
        traceId: details.traceId,
        queuedAt: row.created_at
      }
    })
    const last = page.at(-1)

    return {
      items,
      nextCursor:
        rows.length > size && last
          ? { createdAt: last.created_at, localQueueUuid: last.local_queue_uuid }
          : null
    }
  }

  /**
   * Pending invoice uploads that belong to a *different* company or device than the one given.
   *
   * These are deliberately invisible to claimNextInvoiceUpload. Counting them separately is what
   * lets the worker say "N queued sales cannot be uploaded from this login" instead of leaving them
   * silently stuck with no explanation.
   */
  countForeignPendingUploads(owner: SyncQueueUploadOwner): number {
    const row = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM sync_queue q
          JOIN local_invoices i ON i.local_uuid = q.local_aggregate_uuid
          WHERE q.aggregate_type = 'invoice' AND q.operation = 'upload'
            AND q.state IN ('pending', 'retryable_error')
            AND (i.company_uuid <> ? OR i.device_uuid <> ?)
        `
      )
      .get(owner.companyUuid, owner.deviceUuid) as { readonly count: number }

    return row.count
  }

  private updateGuarded(
    localQueueUuid: string,
    expectedState: SyncQueueState,
    sql: string,
    parameters: readonly unknown[]
  ): void {
    const row = this.database
      .prepare('SELECT state FROM sync_queue WHERE local_queue_uuid = ?')
      .get(localQueueUuid) as SyncQueueRow | undefined

    if (!row || !isSyncQueueState(row.state)) {
      throw new Error('Sync queue item was not found')
    }

    if (row.state !== expectedState) {
      throw new Error(`Sync queue item is ${row.state}, not ${expectedState}`)
    }

    const result = this.database.prepare(sql).run(...parameters) as UpdateResult

    if (result.changes !== 1) {
      throw new Error('Sync queue item changed before its transition could be committed')
    }
  }

  /**
   * @param pausedReason the worker's in-memory pause reason, or null when it is not paused. The
   *   pause is deliberately **not** a persisted queue state (there is no seventh state and no
   *   per-item pause), so this repository never invents one — it reports what the caller knows.
   */
  getStatus(pausedReason: string | null = null): SyncStatus {
    const rows = this.database
      .prepare('SELECT state, COUNT(*) AS count FROM sync_queue GROUP BY state')
      .all() as SyncCountRow[]
    const counts: SyncCounts = {
      pending: 0,
      uploading: 0,
      retryableError: 0,
      conflict: 0,
      rejected: 0
    }

    for (const row of rows) {
      if (row.state === 'pending') counts.pending = row.count
      if (row.state === 'uploading') counts.uploading = row.count
      if (row.state === 'retryable_error') counts.retryableError = row.count
      if (row.state === 'conflict') counts.conflict = row.count
      if (row.state === 'rejected') counts.rejected = row.count
    }

    return {
      state: pausedReason === null ? 'idle' : 'paused',
      pausedReason,
      counts
    }
  }
}
