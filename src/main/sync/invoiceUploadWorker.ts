import type { PublicAppError } from '@shared/contracts/api.contract'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import { isPublicAppError } from '../http/apiError'
import { payloadHash } from '../services/localSale.fingerprint'
import type {
  ClaimedInvoiceUpload,
  InvoiceUploadCandidate,
  SyncQueueRepository,
  SyncQueueUploadOwner
} from '../repositories/syncQueue.repository'
import type { UploadDependencyRepository } from '../repositories/uploadDependency.repository'
import type { InvoiceUploadAccepted } from './invoiceUpload.client'
import type { InvoiceUploadOutcomeRecorder } from './invoiceUploadOutcome'
import { mapUploadFailure, type SyncPauseReason } from './invoiceUploadMapping'
import { isUploadLeaseExpired } from './syncPolicy'

const UPLOAD_LEASE_DURATION_MS = 60_000
/** A payload whose hash no longer matches is never sent; this is how long before it is re-examined. */
const INTEGRITY_HOLD_MS = 3_600_000
const CONTRACT_FAILURE_DIAGNOSTIC_ATTEMPTS = 5
/** Rev 4 §10.2: the server refuses `sold_at > received_at + 60 s`; 5 s of margin is kept. */
export const V3_SEND_MARGIN_MS = 55_000
/** Rev 4 §10.5: no timer is armed further out than this; the deadline is recomputed when it fires. */
export const MAX_WAKE_MS = 300_000
const SAMPLE_RETRY_INITIAL_MS = 30_000
const SAMPLE_RETRY_MAX_MS = 300_000

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
  /**
   * Rev 4 §10.2 v3 send gate. `lowerBound()` is the server-time lower bound (epoch ms) or null when
   * no usable sample exists; `requestSample()` asks for one single-flight probe. Absent → no gate.
   */
  readonly timeGate?: {
    lowerBound(): number | null
    requestSample(): void
  }
  /** Rev 4 §10.3 allocation-chain dependencies. Absent → every candidate is independent. */
  readonly uploadDependencies?: Pick<UploadDependencyRepository, 'evaluate'>
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
  /** Per-drain, in memory only: the earliest time-deferral wake and whether a sample is awaited. */
  private deferredWakeMs: number | null = null
  private awaitingSample = false
  private sampleRetryMs = SAMPLE_RETRY_INITIAL_MS

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
    // Startup reconciliation acts only for the authoritative company/device this session belongs
    // to. Until that owner exists there is nothing this process has authority over, so it does
    // nothing at all rather than performing a global sweep: another company's or another device's
    // rows are not ours to move, and writing their state would be a cross-owner mutation even
    // though no request is sent. The owner is read from main-owned session metadata; no renderer
    // or IPC payload can supply it.
    const reconciliationOwner = this.currentUploadOwner()

    if (reconciliationOwner === null) {
      this.log('reconciliation-skipped no-session-owner')
    } else {
      // Rows left `uploading` by a crash are freed first, so a killed process cannot strand a sale.
      const reclaimed = this.dependencies.syncQueue.reclaimExpiredUploadLeases(
        reconciliationOwner,
        nowIso,
        (leaseAt, now) => isUploadLeaseExpired(leaseAt, now, UPLOAD_LEASE_DURATION_MS)
      )

      if (reclaimed.length > 0) {
        this.log(`reclaimed-expired-leases ${reclaimed.length}`)
      }

      this.dependencies.syncQueue.releaseDueRetries(reconciliationOwner, nowIso)
    }

    this.deferredWakeMs = null
    this.awaitingSample = false

    while (!this.stopped) {
      const owner = this.authorize()

      if (owner === null) {
        break
      }

      this.setPaused(null)

      const claimed = this.dependencies.syncQueue.claimNextInvoiceUpload(
        owner,
        this.now().toISOString(),
        (candidate) => this.accept(candidate)
      )

      if (claimed === null) {
        break
      }

      const result = await this.dispatch(claimed, owner)

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
    this.rearm()
    this.dependencies.onStatusChanged?.()

    return { uploaded, duplicates, failed, pausedReason: this.pausedReason }
  }

  /**
   * Judged inside the claim transaction. A refusal leaves the row untouched — payload, hash,
   * idempotency key, attempt count and `next_attempt_at` are exactly as committed.
   */
  private accept(candidate: InvoiceUploadCandidate): boolean {
    const dependencies = this.dependencies.uploadDependencies
    if (dependencies) {
      const decision = dependencies.evaluate(candidate.invoiceLocalUuid)
      if (!decision.eligible) {
        this.log(
          `upload-held ${candidate.localQueueUuid} ${decision.block}` +
            (decision.predecessor ? ` after=${decision.predecessor.invoiceLocalUuid}` : '')
        )
        return false
      }
    }

    const gate = this.dependencies.timeGate
    if (!gate) {
      return true
    }

    let version: unknown
    let soldAt: unknown
    try {
      const payload = JSON.parse(candidate.payloadJson) as Record<string, unknown>
      version = payload.client_contract_version
      soldAt = payload.sold_at
    } catch {
      // The integrity check in dispatch() owns an unreadable payload.
      return true
    }

    if (version !== 3) {
      return true
    }

    const soldAtMs = typeof soldAt === 'string' ? Date.parse(soldAt) : Number.NaN
    if (!Number.isFinite(soldAtMs)) {
      return true
    }

    const lowerBound = gate.lowerBound()
    if (lowerBound === null) {
      // No usable estimate never authorizes a v3 send.
      this.awaitingSample = true
      return false
    }

    const earliest = soldAtMs - V3_SEND_MARGIN_MS
    if (earliest > lowerBound) {
      const wake = Math.max(1_000, earliest - lowerBound)
      this.deferredWakeMs =
        this.deferredWakeMs === null ? wake : Math.min(this.deferredWakeMs, wake)
      this.log(`upload-time-deferred ${candidate.localQueueUuid} ${Math.round(wake)}ms`)
      return false
    }

    return true
  }

  /**
   * Rev 4 §10.5 / §10.5a: after every drain, re-arm the single timer to the earliest FUTURE deadline
   * — a persisted retry, an in-memory time deferral, or a sample-refresh retry — capped at five
   * minutes and recomputed when it fires. A paused worker arms nothing: authority, session and
   * connectivity changes resume it through events, so a retry already due during a pause can never
   * spin. Held dependencies contribute no deadline; their release events call `requestRun()`.
   */
  private rearm(): void {
    if (this.stopped) {
      return
    }

    const owner = this.pausedReason === null ? this.currentUploadOwner() : null
    if (owner === null) {
      this.cancelWake()
      return
    }

    const deadlines: number[] = []
    const nowMs = this.now().getTime()
    const persisted = this.dependencies.syncQueue.nextRetryDeadline(
      owner,
      new Date(nowMs).toISOString()
    )
    if (persisted !== null) {
      const at = Date.parse(persisted)
      if (Number.isFinite(at)) {
        deadlines.push(Math.max(1, at - nowMs))
      }
    }

    if (this.deferredWakeMs !== null) {
      deadlines.push(this.deferredWakeMs)
    }

    if (this.awaitingSample && this.dependencies.timeGate) {
      this.dependencies.timeGate.requestSample()
      deadlines.push(this.sampleRetryMs)
      this.sampleRetryMs = Math.min(this.sampleRetryMs * 2, SAMPLE_RETRY_MAX_MS)
    } else {
      this.sampleRetryMs = SAMPLE_RETRY_INITIAL_MS
    }

    if (deadlines.length === 0) {
      this.cancelWake()
      return
    }

    this.scheduleWake(Math.min(Math.min(...deadlines), MAX_WAKE_MS))
  }

  private cancelWake(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
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

    const owner = this.currentUploadOwner()

    if (owner === null) {
      this.setPaused('session-invalid')
      return null
    }

    return owner
  }

  /**
   * The authoritative company/device this process may act for, or null when there is none.
   *
   * Read from main-owned session metadata on every call — never cached, never passed in, and never
   * sourced from the renderer. `user_uuid` and the session epoch are deliberately **not** part of
   * the tuple: the backend attributes an upload from the immutable shift row, so a sale queued by
   * a colleague, or before a logout and a re-login on this same till, must still be recoverable
   * and uploadable here.
   */
  private currentUploadOwner(): SyncQueueUploadOwner | null {
    const context = this.dependencies.session.getContext()

    if (!context.isAuthenticated || !context.companyUuid || !context.deviceUuid) {
      return null
    }

    return { companyUuid: context.companyUuid, deviceUuid: context.deviceUuid }
  }

  private async dispatch(
    claimed: ClaimedInvoiceUpload,
    owner: { readonly companyUuid: string; readonly deviceUuid: string }
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

    // BH-04B-3: coverage travels with the acceptance so the recorder applies it in the same
    // transaction that resolves the queue row. `owner` is the authorized upload owner this loop
    // already re-derived from main-owned session metadata — never anything the response supplied.
    this.dependencies.recorder.record(claimed, {
      kind: 'synced',
      remoteUuid: accepted.invoice.id,
      serverNumber: accepted.invoice.server_number,
      owner,
      ...(accepted.coverage === undefined ? {} : { coverage: accepted.coverage })
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

    // The retry deadline is persisted by the recorder; the end-of-drain recompute arms the timer.
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
