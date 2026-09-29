import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import type { DesktopApiClient } from '../http/desktopApiClient'
import type { AllocationDispatchRepository } from '../repositories/allocationDispatch.repository'
import type { AllocationAcquisitionService } from './allocationAcquisition.service'

export interface ReconcilerOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

export interface AllocationDispatchReconcilerDependencies {
  readonly dispatches: Pick<AllocationDispatchRepository, 'listOutstanding'>
  readonly acquisition: Pick<AllocationAcquisitionService, 'sendRecorded'>
  readonly connectivity: { getSnapshot(): ConnectivitySnapshot }
  readonly apiClient: Pick<DesktopApiClient, 'assertRequestPreconditions'>
  /** The authenticated session's company + device, or null when no session can send. */
  readonly owner: () => ReconcilerOwner | null
  readonly allocationCapabilitySupported: () => boolean
  /** Fired when at least one outstanding request resolved as granted. Display hint only. */
  readonly onGrantsChanged?: () => void
  /**
   * Fired when a run resolved at least one outstanding request in any way (granted, refused or an
   * integrity outcome), so a status view listing outstanding requests can re-read them. Display
   * hint only: it carries nothing and grants nothing.
   */
  readonly onRequestsResolved?: () => void
  readonly schedule?: (callback: () => void, delayMs: number) => { clear(): void }
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

const MIN_DELAY_MS = 60_000
const MAX_DELAY_MS = 30 * 60_000

function defaultSchedule(callback: () => void, delayMs: number): { clear(): void } {
  const handle = setTimeout(callback, delayMs)
  handle.unref?.()
  return { clear: () => clearTimeout(handle) }
}

/**
 * POS reliability rev 3 — the main-owned owner of every outstanding allocation request.
 *
 * A top-up request identity recorded in `attempt_allocation_dispatches` outlives the sale attempt
 * that produced it: the attempt may commit offline under existing authority, be rejected, or be
 * explicitly cancelled, while the request's server-side effect is still unknown. This service is
 * what keeps such a request from being orphaned. It:
 *
 * - discovers `dispatched` rows for the current company + device (so a restart finds them);
 * - re-sends each one exactly as recorded — same key, same bytes — through the acquisition
 *   service's shared per-key gate, so it never races an attempt's own retry;
 * - never mints a key, never recomputes a deficit, and writes nothing but dispatch rows, grants and
 *   coverage (it has no path to an invoice, payment or queue row, so it cannot recommit a sale);
 * - honours Retry-After and backs off (1 min doubling to 30 min) while rows stay outstanding.
 *
 * A late grant is ingested exactly once (grant UUID primary key; a stored grant is never rewritten)
 * and is then only a device reservation: spendable under the usual `usableGrantsForProduct` rules and
 * sealed or released by the existing lifecycle. It never re-attributes an already uploaded sale.
 */
export class AllocationDispatchReconciler {
  private readonly log: (line: string) => void
  private readonly schedule: (callback: () => void, delayMs: number) => { clear(): void }
  private readonly now: () => Date
  private running: Promise<void> | null = null
  private rerunRequested = false
  private timer: { clear(): void } | null = null
  private consecutiveUnresolvedRuns = 0
  private stopped = false

  constructor(private readonly dependencies: AllocationDispatchReconcilerDependencies) {
    this.log = dependencies.log ?? ((line) => console.info(line))
    this.schedule = dependencies.schedule ?? defaultSchedule
    this.now = dependencies.now ?? (() => new Date())
  }

  /** Idempotent trigger (startup, connectivity online, session start). Never runs concurrently. */
  requestRun(): void {
    if (this.stopped) {
      return
    }
    if (this.running) {
      this.rerunRequested = true
      return
    }
    this.clearTimer()
    this.running = this.run().finally(() => {
      this.running = null
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false
        this.requestRun()
      }
    })
  }

  /** For tests and shutdown: resolves when the current run (if any) has finished. */
  async whenIdle(): Promise<void> {
    await this.running
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private async run(): Promise<void> {
    const owner = this.dependencies.owner()
    if (
      !owner ||
      this.dependencies.connectivity.getSnapshot().status !== 'online' ||
      !this.dependencies.allocationCapabilitySupported() ||
      !this.preconditionsHold()
    ) {
      return
    }

    const nowMs = this.now().getTime()
    const due = this.dependencies.dispatches
      .listOutstanding(owner)
      .filter((row) => row.retryNotBefore === null || Date.parse(row.retryNotBefore) <= nowMs)

    let granted = 0
    let unresolved = 0
    for (const row of due) {
      if (this.stopped) {
        return
      }
      try {
        const resolution = await this.dependencies.acquisition.sendRecorded(row)
        if (resolution.kind === 'granted') {
          granted += 1
        } else if (resolution.kind === 'unresolved') {
          unresolved += 1
        }
      } catch {
        unresolved += 1
      }
    }

    this.log(
      `[pos-allocation] event=dispatch-reconciliation due=${due.length} granted=${granted} unresolved=${unresolved}`
    )

    if (granted > 0) {
      try {
        this.dependencies.onGrantsChanged?.()
      } catch {
        // Display hint only.
      }
    }

    if (due.length - unresolved > 0) {
      try {
        this.dependencies.onRequestsResolved?.()
      } catch {
        // Display hint only.
      }
    }

    const remaining = this.dependencies.dispatches.listOutstanding(owner)
    if (remaining.length === 0) {
      this.consecutiveUnresolvedRuns = 0
      return
    }

    this.consecutiveUnresolvedRuns = unresolved > 0 ? this.consecutiveUnresolvedRuns + 1 : 0
    const backoff = Math.min(
      MIN_DELAY_MS * 2 ** Math.max(0, this.consecutiveUnresolvedRuns - 1),
      MAX_DELAY_MS
    )
    const earliestRetryAfter = remaining
      .map((row) => (row.retryNotBefore ? Date.parse(row.retryNotBefore) - nowMs : 0))
      .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)
    const delay = Math.max(backoff, Number.isFinite(earliestRetryAfter) ? earliestRetryAfter : 0)

    this.clearTimer()
    this.timer = this.schedule(() => {
      this.timer = null
      this.requestRun()
    }, delay)
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

  private clearTimer(): void {
    this.timer?.clear()
    this.timer = null
  }
}
