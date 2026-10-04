import { invoiceReceiptSnapshotRoute } from '@shared/constants/apiRoutes'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { receiptSnapshotStoredSchema } from '../http/desktopResources.contract'
import type { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import type { ReceiptSnapshotRepository } from '../repositories/receiptSnapshot.repository'

/**
 * Owner receipt copies — uploads each accepted sale's frozen receipt snapshot, exactly once.
 *
 * - Sends only snapshots of a version the server advertises (`receipt_snapshot`, latest persisted
 *   bootstrap; a server of version N stores 1..N) and only for sales the server has accepted.
 * - Sends the stored canonical bytes; the payload is never rebuilt, so a retry is always identical.
 * - Started by a persisted bootstrap or an invoice-upload status change; no timer. One sweep at a time;
 *   a request during a sweep queues one more. A context token (company, device, user, epoch) is
 *   re-checked before every request and every write.
 * - Answers: stored (201) or already stored (200) with our hash → accepted; RECEIPT_SNAPSHOT_INVALID or
 *   RECEIPT_SNAPSHOT_CONFLICT → rejected for good; INVOICE_NOT_UPLOADED or a server error → counted
 *   and retried with growing delays, rejected as `retries_exhausted` at the bound; no answer → spaced,
 *   not counted; an access refusal stops the sweep (the client's session handling runs) and counts nothing.
 */

export const MAX_SNAPSHOTS_PER_SWEEP = 50
export const RECEIPT_SNAPSHOT_CAPABILITY = 'receipt_snapshot'

export interface ReceiptSnapshotUploadDependencies {
  readonly repository: Pick<
    ReceiptSnapshotRepository,
    'findDueUploads' | 'markAccepted' | 'markRejected' | 'recordUnsettledAttempt'
  >
  readonly capabilities: Pick<BootstrapSnapshotRepository, 'getCapabilityVersion'>
  readonly apiClient: Pick<DesktopApiClient, 'requestWithMeta'>
  /** `${companyUuid}|${deviceUuid}|${userUuid}|${sessionEpoch}` of the signed-in user, or null. */
  readonly contextKey: () => string | null
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

type Outcome = 'accepted' | 'rejected' | 'retry' | 'stop'

export class ReceiptSnapshotUploadService {
  private running = false
  private rerun = false
  private readonly now: () => Date

  constructor(private readonly dependencies: ReceiptSnapshotUploadDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  /** One bounded sweep of the signed-in company's due snapshots. Never throws. */
  async sweep(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return
    }
    const token = this.dependencies.contextKey()
    const capability = this.dependencies.capabilities.getCapabilityVersion(
      RECEIPT_SNAPSHOT_CAPABILITY
    )
    if (token === null || capability === null || capability < 1) {
      return
    }
    const companyUuid = token.split('|')[0]
    this.running = true
    let stopped = false

    try {
      const due = this.dependencies.repository.findDueUploads(
        companyUuid,
        this.now(),
        MAX_SNAPSHOTS_PER_SWEEP,
        capability
      )
      for (const snapshot of due) {
        if (this.dependencies.contextKey() !== token) {
          return
        }
        const outcome = await this.send(
          snapshot.invoiceLocalUuid,
          snapshot.canonicalContent,
          snapshot.contentSha256,
          token
        )
        if (outcome === 'stop') {
          stopped = true
          return
        }
      }
    } catch {
      // A sweep failure is never surfaced: the snapshot stays pending for a later trigger.
    } finally {
      this.running = false
      const again = this.rerun
      this.rerun = false
      if (again && !stopped) {
        void this.sweep()
      }
    }
  }

  private async send(
    invoiceLocalUuid: string,
    canonicalContent: string,
    contentSha256: string,
    token: string
  ): Promise<Outcome> {
    let answer: { code: string; data: unknown }
    try {
      answer = await this.dependencies.apiClient.requestWithMeta<unknown>(
        invoiceReceiptSnapshotRoute(invoiceLocalUuid),
        JSON.parse(canonicalContent) as unknown,
        { reportOutcome: false }
      )
    } catch (error) {
      if (this.dependencies.contextKey() !== token) {
        return 'stop'
      }
      return this.refused(invoiceLocalUuid, error)
    }
    if (this.dependencies.contextKey() !== token) {
      return 'stop'
    }

    const stored = receiptSnapshotStoredSchema.safeParse(answer.data)
    const at = this.now().toISOString()
    if (
      (answer.code === 'RECEIPT_SNAPSHOT_STORED' ||
        answer.code === 'RECEIPT_SNAPSHOT_ALREADY_STORED') &&
      stored.success &&
      stored.data.local_invoice_uuid === invoiceLocalUuid &&
      stored.data.content_sha256 === contentSha256
    ) {
      this.dependencies.repository.markAccepted(invoiceLocalUuid, at)
      return 'accepted'
    }
    // A success we cannot confirm byte for byte: never marked accepted; retried within the bound.
    this.dependencies.repository.recordUnsettledAttempt(
      invoiceLocalUuid,
      'unconfirmed_success',
      true,
      at
    )
    this.dependencies.log?.('[receipt-snapshot] unconfirmed success answer; will retry')
    return 'retry'
  }

  private refused(invoiceLocalUuid: string, error: unknown): Outcome {
    const at = this.now().toISOString()
    if (!isPublicAppError(error)) {
      this.dependencies.repository.recordUnsettledAttempt(
        invoiceLocalUuid,
        'unexpected_error',
        false,
        at
      )
      return 'retry'
    }
    if (error.category === 'authentication' || error.category === 'authorization') {
      return 'stop'
    }
    if (
      error.backendCode === 'RECEIPT_SNAPSHOT_INVALID' ||
      error.backendCode === 'RECEIPT_SNAPSHOT_CONFLICT'
    ) {
      this.dependencies.repository.markRejected(invoiceLocalUuid, error.backendCode, at)
      this.dependencies.log?.(`[receipt-snapshot] rejected: ${error.backendCode}`)
      return 'rejected'
    }
    // The server answered (sale not accepted for this register yet, a server error): counted.
    // An answer carries an HTTP status, a backend code or a trace id (envelope errors carry no status).
    const answered =
      typeof error.httpStatus === 'number' ||
      error.backendCode !== undefined ||
      error.traceId !== undefined
    this.dependencies.repository.recordUnsettledAttempt(
      invoiceLocalUuid,
      error.backendCode ?? (answered ? `http_${error.httpStatus}` : 'no_answer'),
      answered,
      at
    )
    return 'retry'
  }
}
