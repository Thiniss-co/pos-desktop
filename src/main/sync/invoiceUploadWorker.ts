import type { PublicAppError } from '@shared/contracts/api.contract'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import { isPublicAppError } from '../http/apiError'
import { payloadHash } from '../services/localSale.fingerprint'
import type {
  ClaimedInvoiceUpload,
  SyncQueueRepository,
  SyncQueueUploadOwner
} from '../repositories/syncQueue.repository'
import type { InvoiceUploadAccepted } from './invoiceUpload.client'
import type { InvoiceUploadOutcomeRecorder } from './invoiceUploadOutcome'
import { mapUploadFailure, type SyncPauseReason } from './invoiceUploadMapping'
import { isUploadLeaseExpired } from './syncPolicy'

const UPLOAD_LEASE_DURATION_MS = 60_000
/** A payload whose hash no longer matches is never sent; this is how long before it is re-examined. */
const INTEGRITY_HOLD_MS = 3_600_000
const CONTRACT_FAILURE_DIAGNOSTIC_ATTEMPTS = 5

export interface InvoiceUploadWorkerSessionReader {
  getContext(): {
    readonly isAuthenticated: boolean
    readonly companyUuid: string | null
    readonly deviceUuid: string | null
  }
}

export interface InvoiceUploadWorkerDependencies {
  readonly syncQueue: SyncQueueRepository
  readonly recorder: InvoiceUploadOutcomeRecorder
  readonly commercialAccess: { assertAllowed(action: 'sync'): void }
  readonly permissions: { hasPermission(permission: string): boolean }
  readonly session: InvoiceUploadWorkerSessionReader
  /** Dispatches one frozen payload. Injected so the worker can be driven without HTTP. */
  readonly upload: (payloadJson: string) => Promise<InvoiceUploadAccepted>
  readonly now?: () => Date
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
  readonly log?: (line: string) => void
  readonly onStatusChanged?: () => void
}

export interface InvoiceUploadRunSummary {
  readonly uploaded: number
  readonly duplicates: number
  readonly failed: number
  readonly pausedReason: SyncPauseReason | null
}

/** The permission the backend route requires. Note it is NOT `pos.sell`. */
export const INVOICE_UPLOAD_PERMISSION = 'pos.invoice.upload'

/**
 * Drains queued invoice uploads, one request at a time.
 *
 * Three properties matter more than anything else here:
 *
 * 1. **Authorization is re-evaluated immediately before every dispatch**, never once per drain. A
 *    licence can lapse or a permission be revoked between two invoices in the same loop.
 * 2. **No SQLite transaction is ever open across the HTTP call.** The claim commits, the request
 *    goes out, and the outcome is written in a second transaction.
 * 3. **An upload is never resolved by a timeout.** Silence produces a retry of the *same*
 *    idempotency key, which the server answers with its duplicate response — it never produces a
 *    guess about whether the invoice landed.
 */
export class InvoiceUploadWorker {
  private readonly now: () => Date
  private readonly schedule: (callback: () => void, delayMs: number) => () => void
  private running: Promise<InvoiceUploadRunSummary> | null = null
  private rerunRequested = false
  private cancelTimer: (() => void) | null = null
  private pausedReason: SyncPauseReason | null = null
  private stopped = false

  constructor(private readonly dependencies: InvoiceUploadWorkerDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date())
    this.schedule =
      dependencies.schedule ??
      ((callback, delayMs): (() => void) => {
        const handle = setTimeout(callback, delayMs)
        handle.unref?.()
        return () => clearTimeout(handle)
      })
  }

  getStatus(): SyncStatus {
    return this.dependencies.syncQueue.getStatus(this.pausedReason)
  }

  /** Fire-and-forget trigger. Never throws, never queues more than one pending rerun. */
  requestRun(): void {
    void this.run().catch((error: unknown) => {
      this.log(`invoice-upload-run-failed ${String(error)}`)
    })
  }

  /**
   * Single-flight: a second call while a drain is in progress schedules exactly one rerun rather
   * than dispatching concurrently. Two concurrent drains would race for the same lease and could
   * put the same invoice on the wire twice.
   */
  async run(): Promise<InvoiceUploadRunSummary> {
    if (this.running) {
      this.rerunRequested = true
      return this.running
    }

    this.running = this.drain()

    try {
      return await this.running
    } finally {
      this.running = null

      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false
        this.requestRun()
      }
    }
  }

  shutdown(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private async drain(): Promise<InvoiceUploadRunSummary> {
    let uploaded = 0
    let duplicates = 0
    let failed = 0

    const nowIso = this.now().toISOString()
    // Rows left `uploading` by a crash are freed first, so a killed process cannot strand a sale.
    const reclaimed = this.dependencies.syncQueue.reclaimExpiredUploadLeases(
      nowIso,
      (leaseAt, now) => isUploadLeaseExpired(leaseAt, now, UPLOAD_LEASE_DURATION_MS)
    )

    if (reclaimed.length > 0) {
      this.log(`reclaimed-expired-leases ${reclaimed.length}`)
    }

    this.dependencies.syncQueue.releaseDueRetries(nowIso)

    while (!this.stopped) {
      const owner = this.authorize()

      if (owner === null) {
        break
      }

      this.setPaused(null)

      const claimed = this.dependencies.syncQueue.claimNextInvoiceUpload(
        owner,
        this.now().toISOString()
      )

      if (claimed === null) {
        break
      }

      const result = await this.dispatch(claimed)

      if (result === 'created') {
        uploaded += 1
      } else if (result === 'duplicate') {
        duplicates += 1
      } else {
        failed += 1

        if (result === 'paused') {
          break
        }
      }
    }

    this.reportForeignRows()
    this.dependencies.onStatusChanged?.()

    return { uploaded, duplicates, failed, pausedReason: this.pausedReason }
  }

  /**
   * The ordered, fail-closed authorization gate. Returns the owner tuple uploads may act for, or
   * null after recording why the worker is paused.
   */
  private authorize(): SyncQueueUploadOwner | null {
    try {
      // Subsumes device status, authenticated session, licence validity/grace/overdue, company
      // active, `canSync`, and the online connectivity precondition.
      this.dependencies.commercialAccess.assertAllowed('sync')
    } catch (error) {
      this.setPaused(this.pauseReasonForAccessError(error))
      return null
    }

    // Separate from the check above: evaluate('sync') checks no permission at all. Fail closed —
    // a permission missing from the bootstrap snapshot is a denial, never an "unknown, so allow".
    if (!this.dependencies.permissions.hasPermission(INVOICE_UPLOAD_PERMISSION)) {
      this.setPaused('permission-denied')
      return null
    }

    const context = this.dependencies.session.getContext()

    if (!context.isAuthenticated || !context.companyUuid || !context.deviceUuid) {
      this.setPaused('session-invalid')
      return null
    }

    return { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
  }

  private async dispatch(
    claimed: ClaimedInvoiceUpload
  ): Promise<'created' | 'duplicate' | 'failed' | 'paused'> {
    if (!this.hasIntactPayload(claimed)) {
      // Never sent. The queued payload no longer hashes to what was committed with it, so this is a
      // local integrity problem, not a server conversation. Evidence is preserved untouched and the
      // row is held rather than terminally rejected — repair is a separately authorized workflow.
      this.log(`payload-integrity-mismatch ${claimed.localQueueUuid}`)
      this.dependencies.recorder.record(claimed, {
        kind: 'retryable',
        errorCode: 'payload_integrity_mismatch',
        retryDelayMs: INTEGRITY_HOLD_MS,
        details: { message: 'The queued payload no longer matches its committed hash.' }
      })

      return 'failed'
    }

    let accepted: InvoiceUploadAccepted

    try {
      accepted = await this.dependencies.upload(claimed.payloadJson)
    } catch (error) {
      return this.recordFailure(claimed, error)
    }

    this.dependencies.recorder.record(claimed, {
      kind: 'synced',
      remoteUuid: accepted.invoice.id,
      serverNumber: accepted.invoice.server_number
    })

    return accepted.kind
  }

  private recordFailure(claimed: ClaimedInvoiceUpload, error: unknown): 'failed' | 'paused' {
    const publicError: PublicAppError = isPublicAppError(error)
      ? error
      : {
          category: 'unexpected',
          message: String(error),
          retryable: false
        }
    const disposition = mapUploadFailure(publicError, claimed.attemptCount)

    if (
      disposition.outcome.kind === 'retryable' &&
      publicError.category === 'unexpected' &&
      claimed.attemptCount >= CONTRACT_FAILURE_DIAGNOSTIC_ATTEMPTS
    ) {
      this.log(
        `upload-contract-failure-persisting ${claimed.localQueueUuid} attempts=${claimed.attemptCount}`
      )
    }

    this.dependencies.recorder.record(claimed, disposition.outcome)

    if (disposition.kind === 'pause') {
      this.setPaused(disposition.reason)
      return 'paused'
    }

    if (disposition.outcome.kind === 'retryable') {
      this.scheduleWake(disposition.outcome.retryDelayMs)
    }

    return 'failed'
  }

  private hasIntactPayload(claimed: ClaimedInvoiceUpload): boolean {
    try {
      return payloadHash(JSON.parse(claimed.payloadJson)) === claimed.payloadHash
    } catch {
      return false
    }
  }

  private pauseReasonForAccessError(error: unknown): SyncPauseReason {
    if (!isPublicAppError(error) || error.backendCode === undefined) {
      return 'unknown'
    }

    // CommercialAccessService denials arrive as COMMERCIAL_ACCESS_<REASON>.
    const reason = error.backendCode.replace(/^COMMERCIAL_ACCESS_/, '').toLowerCase()

    if (reason.includes('connectivity') || reason.includes('offline')) {
      return 'offline'
    }

    if (reason.includes('permission')) {
      return 'permission-denied'
    }

    if (reason.includes('device')) {
      return 'device-blocked'
    }

    if (reason.includes('session')) {
      return 'session-invalid'
    }

    if (reason.includes('company')) {
      return 'company-inactive'
    }

    if (reason.includes('feature')) {
      return 'feature-not-enabled'
    }

    if (reason.includes('license') || reason.includes('grace') || reason.includes('validation')) {
      return 'license-denied'
    }

    return 'unknown'
  }

  private reportForeignRows(): void {
    const context = this.dependencies.session.getContext()

    if (!context.companyUuid || !context.deviceUuid) {
      return
    }

    const foreign = this.dependencies.syncQueue.countForeignPendingUploads({
      companyUuid: context.companyUuid,
      deviceUuid: context.deviceUuid
    })

    if (foreign > 0) {
      // Not an error and not uploadable from here — but an operator must be able to find out why a
      // count never reaches zero, rather than watching it sit there unexplained.
      this.log(`foreign-pending-uploads ${foreign}`)
    }
  }

  private scheduleWake(delayMs: number): void {
    if (this.stopped) {
      return
    }

    this.cancelTimer?.()
    this.cancelTimer = this.schedule(
      () => {
        this.cancelTimer = null
        this.requestRun()
      },
      Math.max(delayMs, 0)
    )
  }

  private setPaused(reason: SyncPauseReason | null): void {
    if (this.pausedReason === reason) {
      return
    }

    this.pausedReason = reason
    this.log(reason === null ? 'resumed' : `paused ${reason}`)
    this.dependencies.onStatusChanged?.()
  }

  private log(line: string): void {
    this.dependencies.log?.(`[invoice-upload] ${line}`)
  }
}
