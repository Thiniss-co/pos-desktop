import {
  connectivitySnapshotSchema,
  type ConnectivityRequestOutcome,
  type ConnectivityReason,
  type ConnectivitySnapshot,
  type ConnectivityStatus
} from '@shared/contracts/connectivity.contract'
import { createApiTracer, type ApiTracer } from '../http/apiTrace'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_HEALTHY_INTERVAL_MS = 30_000
const DEFAULT_BACKOFF_BASE_MS = 5_000
const DEFAULT_BACKOFF_MAX_MS = 60_000
const DEFAULT_CHECK_NOW_MIN_GAP_MS = 2_000

export interface ConnectivityServiceDependencies {
  readonly apiOrigin: URL | null
  readonly isOnline: () => boolean
  readonly fetchImplementation: typeof fetch
  readonly timeoutMs?: number
  readonly healthyIntervalMs?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly checkNowMinGapMs?: number
  readonly random?: () => number
  readonly onChange?: (snapshot: ConnectivitySnapshot) => void
  readonly onResume?: (listener: () => void) => () => void
  readonly tracer?: ApiTracer
}

function nowIsoSecond(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function snapshotsMeaningfullyDiffer(
  previous: ConnectivitySnapshot,
  next: ConnectivitySnapshot
): boolean {
  return (
    previous.status !== next.status ||
    previous.networkAvailable !== next.networkAvailable ||
    previous.backendReachable !== next.backendReachable ||
    previous.reason !== next.reason
  )
}

export class ConnectivityService {
  private readonly timeoutMs: number
  private readonly healthyIntervalMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly checkNowMinGapMs: number
  private readonly random: () => number
  private readonly tracer: ApiTracer
  private snapshot: ConnectivitySnapshot
  private inFlight: Promise<ConnectivitySnapshot> | null = null
  private scheduledCheck: ReturnType<typeof setTimeout> | null = null
  private activeAbortController: AbortController | null = null
  private removeResumeListener: (() => void) | null = null
  // A monotonic clock, immune to a backward wall-clock adjustment (NTP sync, DST, manual clock
  // change) incorrectly re-opening or extending the retry throttle window.
  private lastProbeStartedAt: number | null = null
  private failureCount = 0
  private generation = 0
  private started = false
  private stopped = false

  constructor(private readonly dependencies: ConnectivityServiceDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.healthyIntervalMs = dependencies.healthyIntervalMs ?? DEFAULT_HEALTHY_INTERVAL_MS
    this.backoffBaseMs = dependencies.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    this.backoffMaxMs = dependencies.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.checkNowMinGapMs = dependencies.checkNowMinGapMs ?? DEFAULT_CHECK_NOW_MIN_GAP_MS
    this.random = dependencies.random ?? Math.random
    this.tracer = dependencies.tracer ?? createApiTracer()
    this.snapshot = this.freezeSnapshot({
      status: 'checking',
      networkAvailable: null,
      backendReachable: null,
      checkedAt: null,
      lastBackendReachableAt: null,
      reason: dependencies.apiOrigin ? 'startup' : 'unknown'
    })
  }

  getSnapshot(): ConnectivitySnapshot {
    return this.snapshot
  }

  start(): void {
    if (this.started || this.stopped || !this.dependencies.apiOrigin) {
      return
    }

    this.started = true
    this.removeResumeListener =
      this.dependencies.onResume?.(() => {
        void this.requestCheck(true)
      }) ?? null
    void this.requestCheck(true)
  }

  checkNow(): Promise<ConnectivitySnapshot> {
    return this.requestCheck(false)
  }

  reportRequestOutcome(outcome: ConnectivityRequestOutcome): void {
    if (this.stopped || !this.dependencies.apiOrigin) {
      return
    }

    if (outcome.kind === 'http_response') {
      // Only the diagnostic "last reachable" timestamp is refreshed here — `checkedAt` is left to
      // actual /up probes so it keeps a single, unambiguous meaning ("last time the health probe
      // ran") rather than blending in unrelated business-request timing.
      this.updateSnapshot({
        ...this.snapshot,
        lastBackendReachableAt: nowIsoSecond()
      })

      if (this.snapshot.status === 'backend_unreachable') {
        // Not `force`: a request-driven recheck still respects the manual-retry throttle, so a
        // burst of failing business requests cannot drive the probe rate past what the documented
        // backoff allows. `force` is reserved for startup, resume, and an explicit user retry.
        void this.requestCheck(false)
      }

      return
    }

    void this.requestCheck(false)
  }

  shutdown(): void {
    this.started = false
    this.stopped = true
    this.generation += 1

    if (this.scheduledCheck) {
      clearTimeout(this.scheduledCheck)
      this.scheduledCheck = null
    }

    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.removeResumeListener?.()
    this.removeResumeListener = null
  }

  private requestCheck(force: boolean): Promise<ConnectivitySnapshot> {
    if (!this.dependencies.apiOrigin || this.stopped) {
      return Promise.resolve(this.snapshot)
    }

    if (this.inFlight) {
      return this.inFlight
    }

    const startedAt = performance.now()
    if (
      !force &&
      this.lastProbeStartedAt !== null &&
      startedAt - this.lastProbeStartedAt < this.checkNowMinGapMs
    ) {
      return Promise.resolve(this.snapshot)
    }

    if (this.scheduledCheck) {
      clearTimeout(this.scheduledCheck)
      this.scheduledCheck = null
    }

    this.lastProbeStartedAt = startedAt
    const generation = ++this.generation
    const probe = this.runProbe(generation)
    this.inFlight = probe
    void probe.then(
      () => {
        if (this.inFlight === probe) {
          this.inFlight = null
        }
      },
      () => {
        if (this.inFlight === probe) {
          this.inFlight = null
        }
      }
    )

    return probe
  }

  private async runProbe(generation: number): Promise<ConnectivitySnapshot> {
    const apiOrigin = this.dependencies.apiOrigin

    if (!apiOrigin) {
      return this.snapshot
    }

    const networkAvailable = this.readNetworkAvailability()

    if (!networkAvailable) {
      this.commitProbeResult(generation, 'offline', false, null, 'network_offline')
      this.scheduleNext(this.backoffBaseMs)
      return this.snapshot
    }

    if (this.snapshot.status === 'offline') {
      this.updateSnapshot({
        ...this.snapshot,
        status: 'checking',
        networkAvailable: true,
        backendReachable: null,
        checkedAt: nowIsoSecond(),
        reason: 'startup'
      })
    }

    const url = new URL('/up', apiOrigin)
    const controller = new AbortController()
    this.activeAbortController = controller
    let didTimeout = false
    const timeout = setTimeout(() => {
      didTimeout = true
      controller.abort()
    }, this.timeoutMs)
    const startedAt = performance.now()
    this.tracer.start({ method: 'GET', url })

    try {
      const response = await this.dependencies.fetchImplementation(url, {
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        // A redirected host must never be able to make itself look healthy. 'manual' resolves to
        // an opaque, non-ok response for a 3xx instead of silently following it, so a redirect is
        // classified the same as any other unhealthy response below.
        redirect: 'manual',
        signal: controller.signal
      })
      const payload = await response.json().catch(() => null)
      const isHealthy =
        response.ok &&
        typeof payload === 'object' &&
        payload !== null &&
        'status' in payload &&
        payload.status === 'up'

      this.tracer.finish({
        method: 'GET',
        url,
        elapsedMs: Math.round(performance.now() - startedAt),
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined
      })

      if (!isHealthy) {
        this.failureCount += 1
        this.commitProbeResult(generation, 'backend_unreachable', true, false, 'probe_unhealthy')
        this.scheduleNext(this.nextBackoffDelay())
        return this.snapshot
      }

      this.failureCount = 0
      this.commitProbeResult(generation, 'online', true, true, 'probe_succeeded', true)
      this.scheduleNext(this.healthyIntervalMs)
      return this.snapshot
    } catch (error) {
      if (generation !== this.generation || this.stopped) {
        return this.snapshot
      }

      const reason: ConnectivityReason =
        didTimeout || isAbortError(error) ? 'probe_timeout' : 'probe_connection_failed'
      this.tracer.failure({
        method: 'GET',
        url,
        elapsedMs: Math.round(performance.now() - startedAt),
        classification: reason
      })
      this.failureCount += 1
      this.commitProbeResult(generation, 'backend_unreachable', true, false, reason)
      this.scheduleNext(this.nextBackoffDelay())
      return this.snapshot
    } finally {
      clearTimeout(timeout)

      if (this.activeAbortController === controller) {
        this.activeAbortController = null
      }
    }
  }

  private readNetworkAvailability(): boolean {
    try {
      return this.dependencies.isOnline()
    } catch {
      return false
    }
  }

  private commitProbeResult(
    generation: number,
    status: ConnectivityStatus,
    networkAvailable: boolean,
    backendReachable: boolean | null,
    reason: ConnectivityReason,
    didReachBackend = false
  ): void {
    if (generation !== this.generation || this.stopped) {
      return
    }

    this.updateSnapshot({
      status,
      networkAvailable,
      backendReachable,
      checkedAt: nowIsoSecond(),
      lastBackendReachableAt: didReachBackend
        ? nowIsoSecond()
        : this.snapshot.lastBackendReachableAt,
      reason
    })
  }

  private nextBackoffDelay(): number {
    const raw = this.backoffBaseMs * 2 ** Math.max(this.failureCount - 1, 0)
    const jitter = 0.8 + this.random() * 0.4

    // Jitter is applied before the cap, not after, so the delay can never exceed backoffMaxMs.
    return Math.min(Math.round(raw * jitter), this.backoffMaxMs)
  }

  private scheduleNext(delayMs: number): void {
    if (!this.started || this.stopped || !this.dependencies.apiOrigin) {
      return
    }

    if (this.scheduledCheck) {
      clearTimeout(this.scheduledCheck)
    }

    this.scheduledCheck = setTimeout(() => {
      this.scheduledCheck = null
      void this.requestCheck(true)
    }, delayMs)
  }

  private updateSnapshot(snapshot: ConnectivitySnapshot): void {
    const next = this.freezeSnapshot(snapshot)
    const previous = this.snapshot
    this.snapshot = next

    if (snapshotsMeaningfullyDiffer(previous, next)) {
      try {
        this.dependencies.onChange?.(next)
      } catch {
        // Observers must not alter connectivity monitoring.
      }
    }
  }

  private freezeSnapshot(snapshot: ConnectivitySnapshot): ConnectivitySnapshot {
    return Object.freeze(connectivitySnapshotSchema.parse(snapshot))
  }
}
