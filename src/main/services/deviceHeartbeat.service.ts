import { DESKTOP_API_ROUTES, type DesktopApiRoute } from '@shared/constants/apiRoutes'
import { isSessionEndingError } from '@shared/constants/sessionTransitions'
import { isPublicAppError, redactSensitiveText, RETRY_AFTER_STATUSES } from '../http/apiError'
import { deviceRegisterResourceSchema } from '../http/desktopResources.contract'

/**
 * Main-owned device heartbeat (`POST /device/heartbeat`).
 *
 * This is the one deliberate periodic request in the app: it exists so the company dashboard can
 * show which workstations are present. It is presence-only — it never grants, denies or refreshes
 * any local authority, and nothing else in the app reads its outcome.
 *
 * It runs only while a cashier session is valid, because the endpoint is authenticated with the
 * per-login desktop token; with no session there is no credential and nothing is sent.
 *
 * Every timing decision is made on an injected monotonic clock, and every path that can send is
 * bounded below by `notBefore()`:
 *
 *   notBefore = max(lastStartAt + 30 s, retryAfterUntil, backoffUntil (backoff mode),
 *                   deniedProbeAt (denied mode))
 *
 * The only exception is a *verified* access change while denied, which lifts the `deniedProbeAt`
 * term alone. At most one timer and at most one request exist at any time.
 */

export const HEARTBEAT_INTERVAL_MS = 120_000
export const HEARTBEAT_INTERVAL_JITTER = 0.1
export const HEARTBEAT_MIN_GAP_MS = 30_000
export const HEARTBEAT_BACKOFF_BASE_MS = 15_000
export const HEARTBEAT_BACKOFF_MAX_MS = 600_000
export const HEARTBEAT_DENIED_PROBE_MS = 15 * 60_000
export const HEARTBEAT_DENIED_PROBE_JITTER = 0.1
/** `setTimeout`'s largest delay (2^31 − 1 ms, ~24.8 days). A longer wait is chained. */
export const HEARTBEAT_MAX_TIMER_DELAY_MS = 2_147_483_647

const HEARTBEAT_SUCCESS_CODE = 'DEVICE_HEARTBEAT_RECORDED'

export type DeviceHeartbeatMode = 'active' | 'backoff' | 'retry-after' | 'denied'

export type DeviceHeartbeatProbeReason =
  'resume' | 'connectivity-online' | 'access-changed-verified'

/** What the service needs to know about the session — booleans only, never the credential. */
export interface DeviceHeartbeatSessionContext {
  readonly authenticated: boolean
  readonly hasDeviceUuid: boolean
  readonly hasToken: boolean
  readonly sessionEpoch: number
}

export interface DeviceHeartbeatScheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

/** Structurally a `DesktopApiResponse`, so `apiClient.requestWithMeta` satisfies it directly. */
export interface DeviceHeartbeatResponse {
  readonly code: string
  readonly data: unknown
}

export interface DeviceHeartbeatDependencies {
  readonly request: (route: DesktopApiRoute) => Promise<DeviceHeartbeatResponse>
  readonly readSession: () => DeviceHeartbeatSessionContext
  /** A digest of the current access inputs; compared only for equality. */
  readonly accessFingerprint: () => string
  /** Monotonic milliseconds. Never wall-clock: a clock change must not open or extend a window. */
  readonly nowMs?: () => number
  readonly random?: () => number
  readonly scheduler?: DeviceHeartbeatScheduler
  readonly log?: (line: string) => void
}

export interface DeviceHeartbeatState {
  readonly stopped: boolean
  readonly eligible: boolean
  readonly halted: boolean
  readonly generation: number
  readonly mode: DeviceHeartbeatMode
  readonly backoffLevel: number
  readonly lastStartAt: number | null
  readonly nextAttemptAt: number | null
  readonly backoffUntil: number | null
  readonly retryAfterUntil: number | null
  readonly deniedProbeAt: number | null
  readonly notBefore: number
  readonly inFlight: boolean
  readonly timerDueAt: number | null
}

interface InFlightBeat {
  readonly token: number
  readonly generation: number
  readonly startedAt: number
  spannedSuspend: boolean
}

interface ArmedTimer {
  readonly id: number
  readonly handle: unknown
  readonly dueAt: number
}

type BeatOutcome =
  | { readonly kind: 'success'; readonly response: DeviceHeartbeatResponse | undefined }
  | { readonly kind: 'failure'; readonly error: unknown }

type FailureClass =
  | { readonly kind: 'retry-after'; readonly seconds: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'session-ended' }
  | { readonly kind: 'backoff'; readonly transport: boolean }

const defaultScheduler: DeviceHeartbeatScheduler = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

function formatLine(
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): string {
  const rendered = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  return redactSensitiveText(`[pos-heartbeat] event=${event}${rendered ? ` ${rendered}` : ''}`)
}

function classifyFailure(error: unknown): FailureClass {
  if (!isPublicAppError(error)) {
    return { kind: 'backoff', transport: true }
  }

  // The server's own timing instruction wins over our backoff whenever it is usable.
  if (
    error.httpStatus !== undefined &&
    RETRY_AFTER_STATUSES.has(error.httpStatus) &&
    error.retryAfterSeconds !== undefined
  ) {
    return { kind: 'retry-after', seconds: error.retryAfterSeconds }
  }

  if (error.category === 'authorization' || error.backendCode === 'DESKTOP_TOKEN_DEVICE_MISMATCH') {
    return { kind: 'denied' }
  }

  if (error.category === 'authentication') {
    // A session-ending code is already being handled by the API client's onAuthenticatedFailure
    // hook, which ends the session; this generation is over. Any other authentication failure
    // leaves the local session in place, so it is treated like a denial (slow probe) rather than
    // silently stopping presence for the rest of the session.
    return isSessionEndingError(error.backendCode) ? { kind: 'session-ended' } : { kind: 'denied' }
  }

  // "Transport" here means no server answered at all: a server-sent code or status is evidence
  // about the server, never about a sleeping machine.
  return {
    kind: 'backoff',
    transport:
      error.category === 'transport' &&
      error.backendCode === undefined &&
      error.httpStatus === undefined
  }
}

export class DeviceHeartbeatService {
  private readonly nowMs: () => number
  private readonly random: () => number
  private readonly scheduler: DeviceHeartbeatScheduler
  private readonly log: (line: string) => void

  private stopped = false
  private eligible = false
  private epoch: number | null = null
  private generation = 0
  private mode: DeviceHeartbeatMode = 'active'
  /** A session-ending answer was received; nothing more is scheduled for this generation. */
  private halted = false
  private lastStartAt: number | null = null
  private nextAttemptAt: number | null = null
  private backoffLevel = 0
  private backoffUntil: number | null = null
  private retryAfterUntil: number | null = null
  private deniedFingerprint: string | null = null
  private deniedProbeAt: number | null = null
  private inFlight: InFlightBeat | null = null
  private timer: ArmedTimer | null = null
  private requestSequence = 0
  private timerSequence = 0
  private beatsInGeneration = 0

  constructor(private readonly dependencies: DeviceHeartbeatDependencies) {
    this.nowMs = dependencies.nowMs ?? ((): number => performance.now())
    this.random = dependencies.random ?? Math.random
    this.scheduler = dependencies.scheduler ?? defaultScheduler
    this.log = dependencies.log ?? ((line): void => console.info(line))
  }

  /**
   * Re-reads the session and reconciles. Idempotent: with nothing changed it keeps the existing
   * timer. A changed epoch or eligibility starts a new generation with a fresh backoff and an
   * immediate first beat — still bounded by `notBefore()` (the 30 s floor and any Retry-After).
   */
  sync(): void {
    if (this.stopped) {
      return
    }

    this.applyContext(this.readContext())
  }

  /** Re-arms at the stored deadlines. An overdue attempt fires only once `notBefore()` has passed. */
  restoreSchedule(): void {
    if (this.stopped) {
      return
    }

    this.arm()
  }

  /**
   * A hint that an earlier beat may be useful. It can only move the next attempt *down*, and never
   * below `notBefore()`. `resume` and `connectivity-online` act only in `active` mode; while backing
   * off, honoring Retry-After or denied they change nothing. `access-changed-verified` is the only
   * reason that lifts the denied-probe term, and it still respects the 30 s floor and Retry-After.
   */
  requestEarlyProbe(reason: DeviceHeartbeatProbeReason): void {
    if (this.stopped) {
      return
    }

    // While a beat is on the wire its outcome decides the next attempt; a nudge has nothing to move.
    if (this.eligible && !this.halted && !this.inFlight) {
      const now = this.nowMs()

      if (reason === 'access-changed-verified' && this.mode === 'denied') {
        this.deniedProbeAt = Math.min(this.deniedProbeAt ?? now, now)
        this.nextAttemptAt = Math.min(this.nextAttemptAt ?? now, now)
        this.emit('early-probe', { reason })
      } else if (this.mode === 'active') {
        const floor = Math.max(this.notBefore(), now)

        if (this.nextAttemptAt === null || this.nextAttemptAt > floor) {
          this.nextAttemptAt = floor
          this.emit('early-probe', { reason })
        }
      }
    }

    this.arm()
  }

  /**
   * Called on every commercial-access publication. A publication is only a hint, not proof: while
   * denied, an early probe is sent only if the access fingerprint actually differs from the one
   * recorded when the denial was received.
   */
  onAccessSignal(): void {
    if (this.stopped) {
      return
    }

    // A publication may follow a new login; a new epoch means a new generation and fresh backoff.
    this.applyContext(this.readContext())

    if (!this.eligible || this.halted || this.mode !== 'denied') {
      return
    }

    const current = this.readFingerprint()

    if (current !== null && this.deniedFingerprint !== null && current !== this.deniedFingerprint) {
      this.requestEarlyProbe('access-changed-verified')
    }
  }

  /** Drops the timer handle only; every deadline is kept for `resume()`. */
  suspend(): void {
    if (this.stopped) {
      return
    }

    this.clearTimer()

    if (this.inFlight) {
      this.inFlight.spannedSuspend = true
    }

    this.emit('suspend', {})
  }

  resume(): void {
    if (this.stopped) {
      return
    }

    if (this.inFlight) {
      // Its completion re-arms; a transport failure caused by the sleep will not escalate backoff.
      this.emit('resume', { in_flight: true })
      return
    }

    this.emit('resume', {})
    this.restoreSchedule()
    this.requestEarlyProbe('resume')
  }

  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true
    this.clearTimer()
    this.inFlight = null
    this.emit('stopped', {})
  }

  shutdown(): void {
    this.stop()
  }

  getState(): DeviceHeartbeatState {
    return {
      stopped: this.stopped,
      eligible: this.eligible,
      halted: this.halted,
      generation: this.generation,
      mode: this.mode,
      backoffLevel: this.backoffLevel,
      lastStartAt: this.lastStartAt,
      nextAttemptAt: this.nextAttemptAt,
      backoffUntil: this.backoffUntil,
      retryAfterUntil: this.retryAfterUntil,
      deniedProbeAt: this.deniedProbeAt,
      notBefore: this.notBefore(),
      inFlight: this.inFlight !== null,
      timerDueAt: this.timer?.dueAt ?? null
    }
  }

  private readContext(): DeviceHeartbeatSessionContext | null {
    try {
      return this.dependencies.readSession()
    } catch {
      // Eligibility cannot be proven, so nothing is sent.
      this.emit('context-unavailable', {})
      return null
    }
  }

  private readFingerprint(): string | null {
    try {
      return this.dependencies.accessFingerprint()
    } catch {
      return null
    }
  }

  private applyContext(context: DeviceHeartbeatSessionContext | null): void {
    const eligible =
      context !== null && context.authenticated && context.hasDeviceUuid && context.hasToken

    if (!eligible) {
      if (this.eligible) {
        this.generation += 1
        this.emit('session-ineligible', {})
      }

      this.eligible = false
      this.epoch = null
      this.halted = false
      this.resetBackoffAndDenial()
      this.nextAttemptAt = null
      this.clearTimer()
      return
    }

    if (!this.eligible || context.sessionEpoch !== this.epoch) {
      this.generation += 1
      this.eligible = true
      this.epoch = context.sessionEpoch
      this.halted = false
      this.beatsInGeneration = 0
      this.resetBackoffAndDenial()
      // Immediate first beat — `arm()` still holds it to notBefore (30 s floor, Retry-After).
      this.nextAttemptAt = this.nowMs()
      this.emit('session-eligible', {})
    }

    this.arm()
  }

  private resetBackoffAndDenial(): void {
    // retryAfterUntil and lastStartAt deliberately survive: they are promises to the server.
    this.mode = 'active'
    this.backoffLevel = 0
    this.backoffUntil = null
    this.deniedFingerprint = null
    this.deniedProbeAt = null
  }

  private notBefore(): number {
    let floor = Number.NEGATIVE_INFINITY

    if (this.lastStartAt !== null) {
      floor = Math.max(floor, this.lastStartAt + HEARTBEAT_MIN_GAP_MS)
    }

    if (this.retryAfterUntil !== null) {
      floor = Math.max(floor, this.retryAfterUntil)
    }

    if (this.mode === 'backoff' && this.backoffUntil !== null) {
      floor = Math.max(floor, this.backoffUntil)
    }

    if (this.mode === 'denied' && this.deniedProbeAt !== null) {
      floor = Math.max(floor, this.deniedProbeAt)
    }

    return floor
  }

  private dueAt(now: number): number {
    return Math.max(this.nextAttemptAt ?? now, this.notBefore())
  }

  /** Ensures exactly one timer while eligible and idle, and none otherwise. */
  private arm(): void {
    if (this.stopped || !this.eligible || this.halted || this.inFlight) {
      this.clearTimer()
      return
    }

    const now = this.nowMs()
    const dueAt = this.dueAt(now)

    if (this.timer && this.timer.dueAt === dueAt) {
      return
    }

    this.clearTimer()
    const id = ++this.timerSequence
    const delay = Math.min(Math.max(0, dueAt - now), HEARTBEAT_MAX_TIMER_DELAY_MS)
    const handle = this.scheduler.set(() => this.onTimer(id), delay)
    this.timer = { id, handle, dueAt }
  }

  private clearTimer(): void {
    if (!this.timer) {
      return
    }

    const { handle } = this.timer
    this.timer = null
    this.scheduler.clear(handle)
  }

  private onTimer(id: number): void {
    if (this.stopped || !this.timer || this.timer.id !== id) {
      return
    }

    this.timer = null

    // Eligibility is re-proven before every send; a vanished token or a new epoch is handled here
    // even if nobody called sync().
    const context = this.readContext()

    if (
      context === null ||
      !context.authenticated ||
      !context.hasDeviceUuid ||
      !context.hasToken ||
      context.sessionEpoch !== this.epoch
    ) {
      this.applyContext(context)
      return
    }

    const now = this.nowMs()

    if (now < this.dueAt(now)) {
      // A chained long wait, or a timer that fired early: wait out the remainder.
      this.arm()
      return
    }

    this.send(now)
  }

  private send(now: number): void {
    const flight: InFlightBeat = {
      token: ++this.requestSequence,
      generation: this.generation,
      startedAt: now,
      spannedSuspend: false
    }
    this.inFlight = flight
    this.lastStartAt = now
    this.nextAttemptAt = null

    let pending: Promise<DeviceHeartbeatResponse>

    try {
      pending = this.dependencies.request(DESKTOP_API_ROUTES.deviceHeartbeat)
    } catch (error) {
      pending = Promise.reject(error)
    }

    void Promise.resolve(pending)
      .then(
        (response) => this.settle(flight.token, { kind: 'success', response }),
        (error: unknown) => this.settle(flight.token, { kind: 'failure', error })
      )
      .catch(() => undefined)
  }

  private settle(token: number, outcome: BeatOutcome): void {
    const flight = this.inFlight

    if (this.stopped || !flight || flight.token !== token) {
      return
    }

    this.inFlight = null

    if (flight.generation !== this.generation) {
      // The session changed while this beat was on the wire. Its answer belongs to a session that
      // no longer exists, so it changes nothing; the new generation starts from its own state.
      this.emit('late-response-ignored', {})
      this.arm()
      return
    }

    const now = this.nowMs()

    if (outcome.kind === 'success') {
      this.onSuccess(now, outcome.response)
    } else {
      this.onFailure(now, flight, outcome.error)
    }

    this.arm()
  }

  private onSuccess(now: number, response: DeviceHeartbeatResponse | undefined): void {
    const previousMode = this.mode
    this.mode = 'active'
    this.backoffLevel = 0
    this.backoffUntil = null
    this.deniedFingerprint = null
    this.deniedProbeAt = null
    this.nextAttemptAt = now + this.jittered(HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_JITTER)
    this.beatsInGeneration += 1

    // A healthy device logs its first beat and every recovery, not every two minutes.
    if (previousMode !== 'active' || this.beatsInGeneration === 1) {
      // The resource is informational only and never fails a recorded beat.
      const parsed = deviceRegisterResourceSchema.safeParse(response?.data).success

      this.emit('beat-ok', {
        from: previousMode,
        code_expected: response?.code === HEARTBEAT_SUCCESS_CODE,
        resource: parsed ? 'parsed' : 'unrecognized'
      })
    }
  }

  private onFailure(now: number, flight: InFlightBeat, error: unknown): void {
    const failure = classifyFailure(error)
    const code = isPublicAppError(error) ? error.backendCode : undefined
    const status = isPublicAppError(error) ? error.httpStatus : undefined

    if (failure.kind === 'retry-after') {
      this.mode = 'retry-after'
      this.backoffLevel += 1
      this.retryAfterUntil = now + failure.seconds * 1000
      this.nextAttemptAt = this.retryAfterUntil
      this.emit('beat-failed', {
        outcome: 'retry-after',
        code,
        status,
        retry_after_s: failure.seconds
      })
      return
    }

    if (failure.kind === 'denied') {
      this.mode = 'denied'
      this.backoffLevel = 0
      this.backoffUntil = null
      this.deniedFingerprint = this.readFingerprint()
      this.deniedProbeAt =
        now + this.jittered(HEARTBEAT_DENIED_PROBE_MS, HEARTBEAT_DENIED_PROBE_JITTER)
      this.nextAttemptAt = this.deniedProbeAt
      this.emit('beat-failed', { outcome: 'denied', code, status })
      return
    }

    if (failure.kind === 'session-ended') {
      this.halted = true
      this.nextAttemptAt = null
      this.emit('beat-failed', { outcome: 'session-ended', code, status })
      return
    }

    if (failure.transport && flight.spannedSuspend) {
      // The machine slept with the request on the wire; the failure says nothing about the server.
      this.rescheduleAtCurrentLevel(now)
      this.emit('beat-failed', { outcome: 'suspend-interrupted', code, status })
      return
    }

    this.backoffLevel += 1
    this.enterBackoff(now)
    this.emit('beat-failed', { outcome: 'backoff', code, status })
  }

  private rescheduleAtCurrentLevel(now: number): void {
    if (this.mode === 'denied') {
      this.deniedProbeAt =
        now + this.jittered(HEARTBEAT_DENIED_PROBE_MS, HEARTBEAT_DENIED_PROBE_JITTER)
      this.nextAttemptAt = this.deniedProbeAt
      return
    }

    if (this.backoffLevel === 0) {
      this.mode = 'active'
      // Retry as soon as the 30 s floor allows.
      this.nextAttemptAt = now
      return
    }

    this.enterBackoff(now)
  }

  private enterBackoff(now: number): void {
    const exponent = Math.max(0, this.backoffLevel - 1)
    const window = Math.min(
      Math.max(HEARTBEAT_BACKOFF_BASE_MS * 2 ** exponent, HEARTBEAT_BACKOFF_BASE_MS),
      HEARTBEAT_BACKOFF_MAX_MS
    )
    this.mode = 'backoff'
    this.backoffUntil = now + window * (0.5 + 0.5 * this.random())
    this.nextAttemptAt = this.backoffUntil
  }

  private jittered(base: number, spread: number): number {
    return base * (1 + (this.random() * 2 - 1) * spread)
  }

  private emit(event: string, fields: Record<string, string | number | boolean | undefined>): void {
    try {
      const now = this.nowMs()
      const due =
        this.timer?.dueAt ??
        (this.eligible && !this.halted && !this.inFlight && !this.stopped
          ? this.dueAt(now)
          : undefined)
      this.log(
        formatLine(event, {
          ...fields,
          mode: this.mode,
          level: this.backoffLevel,
          next_in_s: due === undefined ? undefined : Math.max(0, Math.round((due - now) / 1000))
        })
      )
    } catch {
      // Logging must never affect scheduling.
    }
  }
}
