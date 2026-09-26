import type { SqliteDatabase } from '../database/connection'

export type PrintJobStatus =
  | 'queued'
  | 'preparing'
  | 'dispatching'
  | 'submitted'
  | 'cancelled'
  | 'failed_before_dispatch'
  | 'outcome_unknown'

export interface PrintJobRow {
  readonly jobUuid: string
  readonly requestId: string
  readonly clientIntentJson: string
  readonly clientIntentSha256: string
  readonly trigger: 'manual' | 'auto' | 'test'
  readonly ownerCompanyUuid: string
  readonly ownerDeviceUuid: string
  readonly requestedByUserUuid: string
  readonly sessionEpochAtClaim: number
  readonly documentKind: 'sale' | 'refund' | 'test'
  readonly documentLocalUuid: string
  readonly documentJson: string
  readonly documentSha256: string
  readonly templateVersion: number
  readonly locale: 'en' | 'ar'
  readonly isReprint: boolean
  readonly factsProjection: string | null
  readonly transactionFactsSha256: string | null
  readonly resolvedOptionsJson: string
  readonly optionsSha256: string
  readonly layoutJson: string | null
  readonly layoutSha256: string | null
  readonly status: PrintJobStatus
  readonly cancelOrigin: 'queue' | 'dialog' | null
  readonly workerLeaseId: string | null
  readonly dispatchToken: string | null
  readonly failureCode: string | null
  readonly osCallbackAt: string | null
  readonly osCallbackSuccess: boolean | null
  readonly osCallbackReason: string | null
  readonly createdAt: string
  readonly preparingAt: string | null
  readonly dispatchedAt: string | null
  readonly unknownAt: string | null
  readonly finishedAt: string | null
  readonly windowReleasedAt: string | null
}

export interface NewPrintJob {
  readonly jobUuid: string
  readonly requestId: string
  readonly clientIntentJson: string
  readonly clientIntentSha256: string
  readonly trigger: 'manual' | 'auto' | 'test'
  readonly ownerCompanyUuid: string
  readonly ownerDeviceUuid: string
  readonly requestedByUserUuid: string
  readonly sessionEpochAtClaim: number
  readonly documentKind: 'sale' | 'refund' | 'test'
  readonly documentLocalUuid: string
  readonly documentJson: string
  readonly documentSha256: string
  readonly templateVersion: number
  readonly locale: 'en' | 'ar'
  readonly isReprint: boolean
  readonly factsProjection: string | null
  readonly transactionFactsSha256: string | null
  readonly resolvedOptionsJson: string
  readonly optionsSha256: string
  readonly createdAt: string
}

interface DbRow {
  job_uuid: string
  request_id: string
  client_intent_json: string
  client_intent_sha256: string
  trigger: string
  owner_company_uuid: string
  owner_device_uuid: string
  requested_by_user_uuid: string
  session_epoch_at_claim: number
  document_kind: string
  document_local_uuid: string
  document_json: string
  document_sha256: string
  template_version: number
  locale: string
  is_reprint: number
  facts_projection: string | null
  transaction_facts_sha256: string | null
  resolved_options_json: string
  options_sha256: string
  layout_json: string | null
  layout_sha256: string | null
  status: string
  cancel_origin: string | null
  worker_lease_id: string | null
  dispatch_token: string | null
  failure_code: string | null
  os_callback_at: string | null
  os_callback_success: number | null
  os_callback_reason: string | null
  created_at: string
  preparing_at: string | null
  dispatched_at: string | null
  unknown_at: string | null
  finished_at: string | null
  window_released_at: string | null
}

function mapRow(row: DbRow): PrintJobRow {
  return {
    jobUuid: row.job_uuid,
    requestId: row.request_id,
    clientIntentJson: row.client_intent_json,
    clientIntentSha256: row.client_intent_sha256,
    trigger: row.trigger as PrintJobRow['trigger'],
    ownerCompanyUuid: row.owner_company_uuid,
    ownerDeviceUuid: row.owner_device_uuid,
    requestedByUserUuid: row.requested_by_user_uuid,
    sessionEpochAtClaim: row.session_epoch_at_claim,
    documentKind: row.document_kind as PrintJobRow['documentKind'],
    documentLocalUuid: row.document_local_uuid,
    documentJson: row.document_json,
    documentSha256: row.document_sha256,
    templateVersion: row.template_version,
    locale: row.locale as PrintJobRow['locale'],
    isReprint: row.is_reprint === 1,
    factsProjection: row.facts_projection,
    transactionFactsSha256: row.transaction_facts_sha256,
    resolvedOptionsJson: row.resolved_options_json,
    optionsSha256: row.options_sha256,
    layoutJson: row.layout_json,
    layoutSha256: row.layout_sha256,
    status: row.status as PrintJobStatus,
    cancelOrigin: row.cancel_origin as PrintJobRow['cancelOrigin'],
    workerLeaseId: row.worker_lease_id,
    dispatchToken: row.dispatch_token,
    failureCode: row.failure_code,
    osCallbackAt: row.os_callback_at,
    osCallbackSuccess: row.os_callback_success === null ? null : row.os_callback_success === 1,
    osCallbackReason: row.os_callback_reason,
    createdAt: row.created_at,
    preparingAt: row.preparing_at,
    dispatchedAt: row.dispatched_at,
    unknownAt: row.unknown_at,
    finishedAt: row.finished_at,
    windowReleasedAt: row.window_released_at
  }
}

/**
 * Receipt-printing plan §D-5 — the print-job journal repository. Every state-changing method is a
 * SINGLE conditional `UPDATE ... WHERE <predicate>` (never a read-then-write), and reports
 * `changes` back to the caller so a stale/duplicate event can be told apart from a real transition
 * — see `receiptPrinting.service.ts` for how each transition's predicate maps to plan §D-5 E.
 */
export class ReceiptPrintJobRepository {
  constructor(private readonly database: SqliteDatabase) {}

  claim(job: NewPrintJob): PrintJobRow | null {
    try {
      this.database
        .prepare(
          `INSERT INTO receipt_print_jobs (
             job_uuid, request_id, client_intent_json, client_intent_sha256, trigger,
             owner_company_uuid, owner_device_uuid, requested_by_user_uuid, session_epoch_at_claim,
             document_kind, document_local_uuid, document_json, document_sha256, template_version,
             locale, is_reprint, facts_projection, transaction_facts_sha256,
             resolved_options_json, options_sha256, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'queued', ?)`
        )
        .run(
          job.jobUuid,
          job.requestId,
          job.clientIntentJson,
          job.clientIntentSha256,
          job.trigger,
          job.ownerCompanyUuid,
          job.ownerDeviceUuid,
          job.requestedByUserUuid,
          job.sessionEpochAtClaim,
          job.documentKind,
          job.documentLocalUuid,
          job.documentJson,
          job.documentSha256,
          job.templateVersion,
          job.locale,
          job.factsProjection,
          job.transactionFactsSha256,
          job.resolvedOptionsJson,
          job.optionsSha256,
          job.createdAt
        )
    } catch {
      return null
    }

    return this.findByJobUuid(job.jobUuid)
  }

  findByJobUuid(jobUuid: string): PrintJobRow | null {
    const row = this.database
      .prepare('SELECT * FROM receipt_print_jobs WHERE job_uuid = ?')
      .get(jobUuid) as DbRow | undefined
    return row ? mapRow(row) : null
  }

  findByRequestId(requestId: string): PrintJobRow | null {
    const row = this.database
      .prepare('SELECT * FROM receipt_print_jobs WHERE request_id = ?')
      .get(requestId) as DbRow | undefined
    return row ? mapRow(row) : null
  }

  findLatestForDocument(documentKind: string, documentLocalUuid: string): PrintJobRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM receipt_print_jobs WHERE document_kind = ? AND document_local_uuid = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(documentKind, documentLocalUuid) as DbRow | undefined
    return row ? mapRow(row) : null
  }

  hasSubmittedOrUnknown(documentKind: string, documentLocalUuid: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM receipt_print_jobs
         WHERE document_kind = ? AND document_local_uuid = ? AND status IN ('submitted','outcome_unknown')
         LIMIT 1`
      )
      .get(documentKind, documentLocalUuid) as { present: number } | undefined
    return row !== undefined
  }

  /** T2: queued -> preparing. */
  beginPreparing(jobUuid: string, workerLeaseId: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='preparing', worker_lease_id=?, preparing_at=?
         WHERE job_uuid = ? AND status = 'queued'`
      )
      .run(workerLeaseId, now, jobUuid).changes
  }

  recordLayout(
    jobUuid: string,
    workerLeaseId: string,
    layoutJson: string,
    layoutSha256: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET layout_json=?, layout_sha256=?
         WHERE job_uuid = ? AND worker_lease_id = ? AND status = 'preparing' AND layout_json IS NULL`
      )
      .run(layoutJson, layoutSha256, jobUuid, workerLeaseId).changes
  }

  /** T7: preparing -> dispatching. Returns changes=0 (no `print()` call should follow) if stale. */
  beginDispatching(
    jobUuid: string,
    workerLeaseId: string,
    dispatchToken: string,
    now: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='dispatching', dispatch_token=?, dispatched_at=?
         WHERE job_uuid = ? AND worker_lease_id = ? AND status = 'preparing' AND layout_json IS NOT NULL`
      )
      .run(dispatchToken, now, jobUuid, workerLeaseId).changes
  }

  /** T9: dispatching -> submitted (also handles a late T14 success from outcome_unknown). */
  markSubmitted(jobUuid: string, dispatchToken: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs
         SET status='submitted', os_callback_at=?, os_callback_success=1, finished_at=?
         WHERE job_uuid = ? AND dispatch_token = ?
           AND status IN ('dispatching','outcome_unknown') AND os_callback_at IS NULL`
      )
      .run(now, now, jobUuid, dispatchToken).changes
  }

  /** T10/T15: dispatching or outcome_unknown -> outcome_unknown (unknown-reason callback). */
  markOutcomeUnknownFromCallback(
    jobUuid: string,
    dispatchToken: string,
    reason: string,
    now: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs
         SET status='outcome_unknown', failure_code='OS_REPORTED_FAILURE', os_callback_at=?,
             os_callback_reason=?, finished_at=?
         WHERE job_uuid = ? AND dispatch_token = ? AND status = 'dispatching'`
      )
      .run(now, reason.slice(0, 120), now, jobUuid, dispatchToken).changes
  }

  /** T11: dispatching -> outcome_unknown (timeout, no callback). */
  markOutcomeUnknownFromTimeout(jobUuid: string, dispatchToken: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='outcome_unknown', failure_code='CALLBACK_TIMEOUT', unknown_at=?
         WHERE job_uuid = ? AND dispatch_token = ? AND status = 'dispatching'`
      )
      .run(now, jobUuid, dispatchToken).changes
  }

  /** T12: dispatching -> cancelled (verified pre-submission dialog cancel). */
  markCancelledFromDialog(
    jobUuid: string,
    dispatchToken: string,
    reason: string,
    now: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs
         SET status='cancelled', cancel_origin='dialog', os_callback_at=?, os_callback_reason=?, finished_at=?
         WHERE job_uuid = ? AND dispatch_token = ? AND status = 'dispatching'`
      )
      .run(now, reason.slice(0, 120), now, jobUuid, dispatchToken).changes
  }

  /** T13: dispatching -> failed_before_dispatch (verified pre-submission rejection). */
  markFailedFromCallback(
    jobUuid: string,
    dispatchToken: string,
    code: string,
    reason: string,
    now: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs
         SET status='failed_before_dispatch', failure_code=?, os_callback_at=?, os_callback_reason=?, finished_at=?
         WHERE job_uuid = ? AND dispatch_token = ? AND status = 'dispatching'`
      )
      .run(code, now, reason.slice(0, 120), now, jobUuid, dispatchToken).changes
  }

  /** T8: dispatching -> failed_before_dispatch (print() threw synchronously). */
  markFailedFromSyncThrow(jobUuid: string, dispatchToken: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='failed_before_dispatch', failure_code='PRINT_CALL_REJECTED', finished_at=?
         WHERE job_uuid = ? AND dispatch_token = ? AND status = 'dispatching'`
      )
      .run(now, jobUuid, dispatchToken).changes
  }

  /** T6: preparing -> failed_before_dispatch (a pre-dispatch preparation/gate failure). */
  markFailedBeforeDispatch(
    jobUuid: string,
    workerLeaseId: string,
    code: string,
    now: string
  ): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='failed_before_dispatch', failure_code=?, finished_at=?
         WHERE job_uuid = ? AND worker_lease_id = ? AND status = 'preparing'`
      )
      .run(code, now, jobUuid, workerLeaseId).changes
  }

  /** T3/T4: queued or preparing -> cancelled (queue). */
  markCancelledFromQueue(jobUuid: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='cancelled', cancel_origin='queue', finished_at=?
         WHERE job_uuid = ? AND status IN ('queued','preparing')`
      )
      .run(now, jobUuid).changes
  }

  /** T5/T6/T17 (startup): sweeps queued/preparing rows left over from a prior process. */
  reconcileStartup(now: string): { failedBeforeDispatch: number; outcomeUnknown: number } {
    const failedBeforeDispatch = this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='failed_before_dispatch', failure_code='INTERRUPTED_BEFORE_DISPATCH', finished_at=?
         WHERE status IN ('queued','preparing')`
      )
      .run(now).changes

    const outcomeUnknown = this.database
      .prepare(
        `UPDATE receipt_print_jobs SET status='outcome_unknown', failure_code='INTERRUPTED_AFTER_DISPATCH', unknown_at=?
         WHERE status = 'dispatching'`
      )
      .run(now).changes

    this.database
      .prepare(
        `UPDATE receipt_print_jobs SET window_released_at=?
         WHERE worker_lease_id IS NOT NULL AND window_released_at IS NULL
           AND status IN ('submitted','cancelled','failed_before_dispatch','outcome_unknown')`
      )
      .run(now)

    return { failedBeforeDispatch, outcomeUnknown }
  }

  recordWindowReleased(jobUuid: string, workerLeaseId: string, now: string): number {
    return this.database
      .prepare(
        `UPDATE receipt_print_jobs SET window_released_at=?
         WHERE job_uuid = ? AND worker_lease_id = ? AND window_released_at IS NULL`
      )
      .run(now, jobUuid, workerLeaseId).changes
  }
}
