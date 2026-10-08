import type { LicenseStatus } from '@shared/contracts/license.contract'
import { StaleAccessResponseError } from './accessOrdering'
import { OwnerChangedError, renewalOwnerKey, type RenewalOwner } from './renewalOwner'

/**
 * Rev 4 §7 — the single owner of license-validation and renewal timing.
 *
 * ## Two legs
 *
 * - **License leg (L)**: `license/validate`, negotiating the v2 authority block. It installs the new
 *   license state, trusted anchor and authority in one owner-checked transaction and never touches
 *   the catalog, so it may run at any time — during an editable cart or a claimed payment attempt.
 * - **Catalog leg (C)**: bootstrap. Every bootstrap mints a new catalog revision, so C is gated by the
 *   catalog-install lifecycle (Rev 4 §8) and is supplied by the caller.
 *
 * ## Single-flight
 *
 * One L at a time per owner. A caller for the SAME owner joins the flight in progress; a caller for a
 * different owner waits for it to settle (it will fail with `OwnerChangedError` inside its own write
 * transaction) and then runs its own. Correctness does not depend on this — the owner re-check inside
 * the write transaction does — but it keeps a device from sending concurrent validations.
 *
 * ## Proactive schedule (bounded)
 *
 *   D     = min(usable-authority not_after for the current warehouse, catalog valid_until)
 *   lead  = min(24h, (D − window start) / 2)        — always shorter than the window, so no loop
 *   fire  = D − lead, ±10% of lead jitter, and never sooner than 5 min after the last successful L
 *
 * If a successful renewal does not move D later (a subscription expiry caps it), proactive renewal
 * stops for that D — no loop near a hard boundary. A transient failure backs off 1 → 30 min and
 * honours `Retry-After`; the still-valid existing authority keeps selling meanwhile. An access
 * denial (a 200 with `can_sell=false`, or an authentication/authorization failure) stops proactive
 * renewal until the session or access state changes.
 */

export type RenewalReason =
  | 'start'
  | 'session'
  | 'online'
  | 'resume'
  | 'timer'
  | 'checkout'
  | 'manual'
  | 'ipc'
  | 'catalog-refresh'

export type LicenseLegOutcome =
  | { readonly kind: 'renewed'; readonly status: LicenseStatus }
  | { readonly kind: 'denied'; readonly status?: LicenseStatus; readonly error?: unknown }
  | { readonly kind: 'owner-changed' }
  | { readonly kind: 'transient'; readonly error: unknown }
  | { readonly kind: 'no-owner' }

export interface RenewalWindow {
  readonly start: string
  readonly end: string
}

export interface RenewalCoordinatorDependencies {
  readonly license: { validate(): Promise<LicenseStatus> }
  readonly owner: () => RenewalOwner | null
  /** The latest stored authority window for the owner's current warehouse, usable or not. */
  readonly authorityWindow: (owner: RenewalOwner) => RenewalWindow | null
  /** The installed catalog contract window. */
  readonly catalogWindow: () => RenewalWindow | null
  /** The catalog leg, already gated by the install lifecycle. Returns whether it installed. */
  readonly catalogLeg?: (reason: RenewalReason) => Promise<unknown>
  /** Whether the installed catalog is stale or missing (selling is impossible until C installs). */
  readonly catalogNeedsInstall?: () => boolean
  readonly wallNow?: () => number
  readonly monotonicNow?: () => number
  readonly random?: () => number
  readonly scheduler?: {
    set(callback: () => void, delayMs: number): unknown
    clear(handle: unknown): void
  }
  readonly onRenewed?: (status: LicenseStatus) => void
  readonly log?: (line: string) => void
}

const HOUR_MS = 3_600_000
const MAX_LEAD_MS = 24 * HOUR_MS
const MIN_GAP_MS = 5 * 60_000
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000
/** A timer never sleeps longer than this; it re-evaluates on waking (clock jumps self-correct). */
const MAX_TIMER_MS = 6 * HOUR_MS
/**
 * Freshness cadence: while online, a catalog older than this is refreshed (L then C) even when the
 * offline deadline is far away — with offline limits switched off it can be years out, and prices and
 * products must still reach an online till about daily.
 */
export const CATALOG_REFRESH_CADENCE_MS = 24 * HOUR_MS

function isDenial(error: unknown): boolean {
  const category = (error as { category?: string } | null)?.category
  return category === 'authentication' || category === 'authorization'
}

function retryAfterMs(error: unknown): number {
  const seconds = (error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : 0
}

export class RenewalCoordinator {
  private flight: { key: string; promise: Promise<LicenseLegOutcome> } | null = null
  private timer: unknown = null
  private denied = false
  private failures = 0
  private backoffUntilMono = 0
  private lastSuccessMono = Number.NEGATIVE_INFINITY
  private noProgressDeadline: number | null = null
  private stopped = false
  private lastPlan: { readonly deadline: number; readonly fireAt: number } | null = null
  private lastOwnerKey: string | null = null
  private catalogPending = false
  private catalogInFlight = false
  private catalogFailures = 0
  /** Retries a pending (deferred or failed) install on its own, so it never depends on another idle report. */
  private catalogRetryTimer: unknown = null
  private lastCatalogAttemptMono = Number.NEGATIVE_INFINITY

  constructor(private readonly dependencies: RenewalCoordinatorDependencies) {}

  private wall(): number {
    return (this.dependencies.wallNow ?? Date.now)()
  }

  private mono(): number {
    return (this.dependencies.monotonicNow ?? (() => performance.now()))()
  }

  /**
   * One license leg for the current owner. Never throws: the outcome is classified so callers
   * (checkout, IPC, scheduler) can decide without guessing.
   */
  licenseLeg(reason: RenewalReason): Promise<LicenseLegOutcome> {
    const owner = this.dependencies.owner()

    if (owner === null) {
      return Promise.resolve({ kind: 'no-owner' })
    }

    const key = renewalOwnerKey(owner)
    const current = this.flight

    if (current && current.key === key) {
      return current.promise
    }

    const run = async (): Promise<LicenseLegOutcome> => {
      if (current) {
        await current.promise.catch(() => undefined)
      }
      return this.runLicenseLeg(reason)
    }

    const promise = run()
    this.flight = { key, promise }
    void promise.finally(() => {
      if (this.flight?.promise === promise) {
        this.flight = null
      }
    })

    return promise
  }

  /** The same leg, but surfacing failures to callers that expect `LicenseService.validate()`. */
  async validateLicense(reason: RenewalReason): Promise<LicenseStatus> {
    const outcome = await this.licenseLeg(reason)

    if (outcome.kind === 'renewed') {
      return outcome.status
    }
    if (outcome.kind === 'denied' && outcome.status) {
      return outcome.status
    }
    if (outcome.kind === 'transient' || outcome.kind === 'denied') {
      throw (outcome as { error: unknown }).error
    }
    if (outcome.kind === 'owner-changed') {
      throw new OwnerChangedError()
    }
    throw new Error('No signed-in workstation owner to validate the license for.')
  }

  private async runLicenseLeg(reason: RenewalReason): Promise<LicenseLegOutcome> {
    try {
      const status = await this.dependencies.license.validate()
      this.failures = 0
      this.backoffUntilMono = 0
      this.lastSuccessMono = this.mono()

      if (!status.canSell) {
        this.denied = true
        this.log(`license leg (${reason}): access denied by the server; proactive renewal paused`)
        this.reschedule()
        return { kind: 'denied', status }
      }

      this.denied = false
      this.dependencies.onRenewed?.(status)
      this.log(`license leg (${reason}): renewed`)
      this.reschedule()
      return { kind: 'renewed', status }
    } catch (error) {
      if (error instanceof OwnerChangedError) {
        // Phase 6 (C3): an older or unsequenced-relaxing access answer is discarded the same way; name it in the log.
        this.log(
          `license leg (${reason}): ${error instanceof StaleAccessResponseError ? error.message : 'owner changed in flight; result discarded'}`
        )
        this.reschedule()
        return { kind: 'owner-changed' }
      }

      if (isDenial(error)) {
        this.denied = true
        this.log(`license leg (${reason}): denied (${(error as { category?: string }).category})`)
        this.reschedule()
        return { kind: 'denied', error }
      }

      this.failures += 1
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1))
      const jittered = backoff * (0.9 + 0.2 * (this.dependencies.random ?? Math.random)())
      this.backoffUntilMono = this.mono() + Math.max(jittered, retryAfterMs(error))
      this.log(`license leg (${reason}): transient failure #${this.failures}; backing off`)
      this.reschedule()
      return { kind: 'transient', error }
    }
  }

  /** L then, when allowed, C. Used by the timer, reconnect/resume/start and manual refresh. */
  async renew(reason: RenewalReason): Promise<LicenseLegOutcome> {
    const deadlineBefore = this.currentDeadline()
    const outcome = await this.licenseLeg(reason)

    if (outcome.kind === 'renewed' && this.dependencies.catalogLeg) {
      const catalogNeeded =
        reason === 'manual' ||
        (this.dependencies.catalogNeedsInstall?.() ?? false) ||
        this.catalogWithinLead() ||
        this.catalogDueByCadence()

      if (catalogNeeded) {
        await this.runCatalogLeg(reason)
      }
    }

    if (outcome.kind === 'renewed') {
      // No-progress guard over the whole cycle (L and, when it ran, C): if the deadline did not move
      // later, a hard boundary (subscription expiry, plan) caps it — stop proactive renewal for it.
      const deadlineAfter = this.currentDeadline()
      this.noProgressDeadline =
        deadlineAfter !== null && deadlineBefore !== null && deadlineAfter <= deadlineBefore
          ? deadlineAfter
          : null
      this.reschedule()
    }

    return outcome
  }

  /**
   * Rev 4 §8.3: one catalog leg. A deferral (the draft is not idle, a payment is active) leaves the
   * install PENDING; it is retried on the next idle draft report or when the bounded catalog backoff
   * (30 s → 5 min) elapses, whichever comes first, and the payload is always fetched again.
   */
  private async runCatalogLeg(reason: RenewalReason): Promise<void> {
    if (!this.dependencies.catalogLeg) {
      return
    }
    this.lastCatalogAttemptMono = this.mono()
    try {
      await this.dependencies.catalogLeg(reason)
      this.catalogPending = false
      this.catalogFailures = 0
      this.clearCatalogRetry()
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      this.catalogPending = true
      this.catalogFailures += 1
      this.armCatalogRetry()
      this.log(
        `catalog leg (${reason}): ${code === 'install-deferred' ? 'deferred' : ((error as Error)?.message ?? 'failed')}`
      )
    }
  }

  private catalogBackoffMs(): number {
    return Math.min(300_000, 30_000 * 2 ** Math.max(0, this.catalogFailures - 1))
  }

  private armCatalogRetry(): void {
    this.clearCatalogRetry()
    if (this.stopped || this.dependencies.owner() === null) {
      return
    }
    this.catalogRetryTimer = this.scheduler().set(() => {
      this.catalogRetryTimer = null
      this.onDraftIdle()
    }, this.catalogBackoffMs())
  }

  private clearCatalogRetry(): void {
    if (this.catalogRetryTimer !== null) {
      this.scheduler().clear(this.catalogRetryTimer)
      this.catalogRetryTimer = null
    }
  }

  private scheduler(): {
    set: (callback: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  } {
    return (
      this.dependencies.scheduler ?? {
        set: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      }
    )
  }

  /** The POS draft became idle (or the pending retry fired): retry a pending install (bounded). */
  onDraftIdle(): void {
    if (!this.catalogPending || this.catalogInFlight) {
      return
    }
    if (this.mono() - this.lastCatalogAttemptMono < this.catalogBackoffMs()) {
      return
    }
    this.catalogInFlight = true
    void this.runCatalogLeg('timer').finally(() => {
      this.catalogInFlight = false
      this.reschedule()
    })
  }

  hasPendingCatalog(): boolean {
    return this.catalogPending
  }

  // --- triggers ------------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    this.lastOwnerKey = renewalOwnerKey(this.dependencies.owner())
    void this.renew('start')
  }

  /**
   * Called on every session notification. Only a CHANGED owner (sign-in, sign-out, a different
   * user/company/device binding, a new epoch, a reassignment) resets state and renews; a
   * same-owner refresh (e.g. `/auth/me` during a catalog refresh) changes nothing.
   */
  onSessionChanged(): void {
    const owner = this.dependencies.owner()
    const key = renewalOwnerKey(owner)

    if (key === this.lastOwnerKey) {
      return
    }

    this.lastOwnerKey = key
    this.denied = false
    this.noProgressDeadline = null
    this.failures = 0
    this.backoffUntilMono = 0

    if (owner === null) {
      this.clearTimer()
      this.clearCatalogRetry()
      return
    }
    void this.renew('session')
  }

  onAccessChanged(): void {
    if (this.denied) {
      this.denied = false
      this.reschedule()
    }
  }

  onOnline(): void {
    void this.renew('online')
  }

  onResume(): void {
    void this.renew('resume')
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.clearCatalogRetry()
  }

  /** Diagnostic snapshot for tests and support. */
  describe(): {
    readonly denied: boolean
    readonly failures: number
    readonly noProgressDeadline: number | null
    readonly plan: { readonly deadline: number; readonly fireAt: number } | null
    readonly timerArmed: boolean
  } {
    return {
      denied: this.denied,
      failures: this.failures,
      noProgressDeadline: this.noProgressDeadline,
      plan: this.lastPlan,
      timerArmed: this.timer !== null
    }
  }

  // --- scheduling ----------------------------------------------------------------------------

  private window(): RenewalWindow | null {
    const owner = this.dependencies.owner()
    const candidates = [
      owner ? this.dependencies.authorityWindow(owner) : null,
      this.dependencies.catalogWindow()
    ].filter((w): w is RenewalWindow => w !== null)

    if (candidates.length === 0) {
      return null
    }

    return candidates.reduce((earliest, w) =>
      Date.parse(w.end) < Date.parse(earliest.end) ? w : earliest
    )
  }

  private currentDeadline(): number | null {
    const w = this.window()
    const end = w ? Date.parse(w.end) : Number.NaN
    return Number.isFinite(end) ? end : null
  }

  private leadMs(w: RenewalWindow): number {
    const length = Date.parse(w.end) - Date.parse(w.start)
    return Math.max(0, Math.min(MAX_LEAD_MS, length / 2))
  }

  private catalogWithinLead(): boolean {
    const catalog = this.dependencies.catalogWindow()

    if (catalog === null) {
      return true
    }

    return this.wall() >= Date.parse(catalog.end) - this.leadMs(catalog)
  }

  /** The installed catalog was generated more than one cadence ago (or there is none). */
  private catalogDueByCadence(): boolean {
    const catalog = this.dependencies.catalogWindow()
    const generatedAt = catalog ? Date.parse(catalog.start) : Number.NaN
    return !Number.isFinite(generatedAt) || this.wall() >= generatedAt + CATALOG_REFRESH_CADENCE_MS
  }

  /** Recompute and re-arm the single proactive timer. Called after every leg and trigger. */
  reschedule(): void {
    this.clearTimer()
    this.lastPlan = null

    if (this.stopped || this.denied || this.dependencies.owner() === null) {
      return
    }

    // Two candidate fire times; the earlier wins. The deadline candidate (renew ahead of the
    // earliest authority/catalog end) is dropped when renewing cannot move that deadline (the
    // no-progress guard); the freshness cadence never is.
    const candidates: { readonly deadline: number; readonly fireAt: number }[] = []
    const w = this.window()
    const deadline = w ? Date.parse(w.end) : Number.NaN
    if (w !== null && Number.isFinite(deadline) && this.noProgressDeadline !== deadline) {
      const lead = this.leadMs(w)
      const jitter = (((this.dependencies.random ?? Math.random)() * 2 - 1) * lead) / 10
      candidates.push({ deadline, fireAt: deadline - lead + jitter })
    }
    const catalog = this.dependencies.catalogWindow()
    const generatedAt = catalog ? Date.parse(catalog.start) : Number.NaN
    if (Number.isFinite(generatedAt)) {
      const cadenceAt = generatedAt + CATALOG_REFRESH_CADENCE_MS
      candidates.push({
        deadline: Number.isFinite(deadline) ? deadline : cadenceAt,
        fireAt: cadenceAt
      })
    }

    if (candidates.length === 0) {
      return
    }

    const next = candidates.reduce((earliest, c) => (c.fireAt < earliest.fireAt ? c : earliest))
    const fireAtWall = next.fireAt
    const nowWall = this.wall()
    const nowMono = this.mono()
    const gapRemaining = Math.max(0, this.lastSuccessMono + MIN_GAP_MS - nowMono)
    const backoffRemaining = Math.max(0, this.backoffUntilMono - nowMono)
    const delay = Math.max(fireAtWall - nowWall, gapRemaining, backoffRemaining, 0)

    this.lastPlan = { deadline: next.deadline, fireAt: nowWall + delay }
    this.arm(Math.min(delay, MAX_TIMER_MS), delay <= MAX_TIMER_MS)
  }

  private arm(delayMs: number, fires: boolean): void {
    const scheduler = this.dependencies.scheduler ?? {
      set: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }

    this.timer = scheduler.set(() => {
      this.timer = null
      if (fires) {
        void this.renew('timer')
      } else {
        this.reschedule()
      }
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      const scheduler = this.dependencies.scheduler ?? {
        set: () => null,
        clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      }
      scheduler.clear(this.timer)
      this.timer = null
    }
  }

  private log(line: string): void {
    this.dependencies.log?.(`[pos-renewal] ${line}`)
  }
}
