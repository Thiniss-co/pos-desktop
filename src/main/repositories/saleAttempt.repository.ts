import type { SaleAttemptRow, SaleAttemptState } from '@shared/contracts/sale.contract'
import type { SqliteDatabase } from '../database/connection'

export interface OwnerTuple {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
}

export interface NewSaleAttempt extends OwnerTuple {
  readonly attemptKey: string
  readonly claimSessionEpoch: number
  readonly originShiftUuid: string
  readonly originShiftObservedAt: string
  readonly originBranchUuid: string
  readonly originWarehouseUuid: string
  readonly originContextFingerprint: string
  readonly intentFingerprint: string
  readonly intentVersion: number
  readonly intentJson: string
}

interface SaleAttemptTableRow {
  readonly attempt_key: string
  readonly company_uuid: string
  readonly device_uuid: string
  readonly user_uuid: string
  readonly claim_session_epoch: number
  readonly origin_shift_uuid: string
  readonly origin_shift_observed_at: string
  readonly origin_branch_uuid: string
  readonly origin_warehouse_uuid: string
  readonly origin_context_fingerprint: string
  readonly intent_fingerprint: string
  readonly intent_version: number
  readonly intent_json: string | null
  readonly state: SaleAttemptState
  readonly invoice_local_uuid: string | null
  readonly failure_code: string | null
  readonly claimed_at: string
  readonly last_attempted_at: string | null
  readonly committed_at: string | null
  readonly rejected_at: string | null
  readonly acknowledged_at: string | null
  readonly abandoned_at: string | null
  readonly updated_at: string
}

function mapRow(row: SaleAttemptTableRow): SaleAttemptRow {
  return {
    attemptKey: row.attempt_key,
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    userUuid: row.user_uuid,
    claimSessionEpoch: row.claim_session_epoch,
    originShiftUuid: row.origin_shift_uuid,
    originShiftObservedAt: row.origin_shift_observed_at,
    originBranchUuid: row.origin_branch_uuid,
    originWarehouseUuid: row.origin_warehouse_uuid,
    originContextFingerprint: row.origin_context_fingerprint,
    intentFingerprint: row.intent_fingerprint,
    intentVersion: row.intent_version,
    intentJson: row.intent_json,
    state: row.state,
    invoiceLocalUuid: row.invoice_local_uuid,
    failureCode: row.failure_code,
    claimedAt: row.claimed_at,
    lastAttemptedAt: row.last_attempted_at,
    committedAt: row.committed_at,
    rejectedAt: row.rejected_at,
    acknowledgedAt: row.acknowledged_at,
    abandonedAt: row.abandoned_at,
    updatedAt: row.updated_at
  }
}

/**
 * CP-1 repository foundation only: narrow, typed reads/writes over `sale_attempts`. The existing-
 * state dispatcher, fingerprint comparison, and transition decisions are CP-2's
 * `localSale.service.ts` — this repository never decides which transition is legal, it only
 * performs the exact one it is asked for and lets the schema's own CHECKs and partial unique index
 * (idx_sale_attempts_one_blocking) fail closed on an illegal one. It opens no transaction of its
 * own; the caller's business transaction owns atomicity.
 */
export class SaleAttemptRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** Owner-scoped lookup by exact key — never a bare lookup by key alone (plan §1.1). */
  findByKeyForOwner(attemptKey: string, owner: OwnerTuple): SaleAttemptRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM sale_attempts
           WHERE attempt_key = ? AND company_uuid = ? AND device_uuid = ? AND user_uuid = ?`
      )
      .get(attemptKey, owner.companyUuid, owner.deviceUuid, owner.userUuid) as
      SaleAttemptTableRow | undefined

    return row ? mapRow(row) : null
  }

  /** The at-most-one `claimed` row for this owner, enforced by the schema's partial unique index. */
  findBlockingForOwner(owner: OwnerTuple): SaleAttemptRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM sale_attempts
           WHERE company_uuid = ? AND device_uuid = ? AND user_uuid = ? AND state = 'claimed'`
      )
      .get(owner.companyUuid, owner.deviceUuid, owner.userUuid) as SaleAttemptTableRow | undefined

    return row ? mapRow(row) : null
  }

  /**
   * Keyset-paginated committed-but-unacknowledged results for one owner, ordered exactly as the
   * plan requires (committed_at ASC, attempt_key ASC) so acknowledging one row can never skip or
   * hide another.
   */
  listUnacknowledgedCommittedForOwner(
    owner: OwnerTuple,
    limit: number,
    after: { readonly committedAt: string; readonly attemptKey: string } | null
  ): readonly SaleAttemptRow[] {
    const rows = after
      ? (this.database
          .prepare(
            `SELECT * FROM sale_attempts
               WHERE company_uuid = ? AND device_uuid = ? AND user_uuid = ? AND state = 'committed'
                 AND (committed_at, attempt_key) > (?, ?)
               ORDER BY committed_at ASC, attempt_key ASC
               LIMIT ?`
          )
          .all(
            owner.companyUuid,
            owner.deviceUuid,
            owner.userUuid,
            after.committedAt,
            after.attemptKey,
            limit
          ) as SaleAttemptTableRow[])
      : (this.database
          .prepare(
            `SELECT * FROM sale_attempts
               WHERE company_uuid = ? AND device_uuid = ? AND user_uuid = ? AND state = 'committed'
               ORDER BY committed_at ASC, attempt_key ASC
               LIMIT ?`
          )
          .all(owner.companyUuid, owner.deviceUuid, owner.userUuid, limit) as SaleAttemptTableRow[])

    return rows.map(mapRow)
  }

  /** T1: a genuinely new claim. A primary-key or partial-unique-index collision throws. */
  claim(attempt: NewSaleAttempt): SaleAttemptRow {
    const claimedAt = this.now()
    this.database
      .prepare(
        `INSERT INTO sale_attempts (
           attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
           origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
           origin_context_fingerprint, intent_fingerprint, intent_version, intent_json,
           state, claimed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`
      )
      .run(
        attempt.attemptKey,
        attempt.companyUuid,
        attempt.deviceUuid,
        attempt.userUuid,
        attempt.claimSessionEpoch,
        attempt.originShiftUuid,
        attempt.originShiftObservedAt,
        attempt.originBranchUuid,
        attempt.originWarehouseUuid,
        attempt.originContextFingerprint,
        attempt.intentFingerprint,
        attempt.intentVersion,
        attempt.intentJson,
        claimedAt,
        claimedAt
      )

    const created = this.findByKeyForOwner(attempt.attemptKey, attempt)

    if (!created) {
      throw new Error('Sale attempt claim did not persist')
    }

    return created
  }

  /** T2/T4: the claimed row is flipped to committed in the same business transaction. */
  markCommitted(attemptKey: string, invoiceLocalUuid: string, committedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE sale_attempts
           SET state = 'committed', invoice_local_uuid = ?, committed_at = ?,
               last_attempted_at = ?, updated_at = ?
         WHERE attempt_key = ? AND state = 'claimed'`
      )
      .run(invoiceLocalUuid, committedAt, committedAt, committedAt, attemptKey)

    if (result.changes !== 1) {
      throw new Error('Sale attempt was not in a claimed state to commit')
    }
  }

  /** T3: a definite rejection, recorded in its own transaction after the business rollback. */
  markRejected(attemptKey: string, failureCode: string, rejectedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE sale_attempts
           SET state = 'rejected', failure_code = ?, intent_json = NULL,
               rejected_at = ?, last_attempted_at = ?, updated_at = ?
         WHERE attempt_key = ? AND state = 'claimed'`
      )
      .run(failureCode, rejectedAt, rejectedAt, rejectedAt, attemptKey)

    if (result.changes !== 1) {
      throw new Error('Sale attempt was not in a claimed state to reject')
    }
  }

  /** T7: acknowledgment purges the retained intent but never touches the immutable result rows. */
  markAcknowledged(attemptKey: string, acknowledgedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE sale_attempts
           SET state = 'acknowledged', intent_json = NULL, acknowledged_at = ?, updated_at = ?
         WHERE attempt_key = ? AND state = 'committed'`
      )
      .run(acknowledgedAt, acknowledgedAt, attemptKey)

    if (result.changes !== 1) {
      throw new Error('Sale attempt was not in a committed state to acknowledge')
    }
  }

  /** T5: abandon a proven-uncommitted claimed attempt (D1-A). */
  markAbandoned(attemptKey: string, abandonedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE sale_attempts
           SET state = 'abandoned', intent_json = NULL, abandoned_at = ?, updated_at = ?
         WHERE attempt_key = ? AND state = 'claimed'`
      )
      .run(abandonedAt, abandonedAt, attemptKey)

    if (result.changes !== 1) {
      throw new Error('Sale attempt was not in a claimed state to abandon')
    }
  }
}
