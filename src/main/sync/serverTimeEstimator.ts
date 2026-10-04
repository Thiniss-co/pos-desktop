/**
 * Rev 4 §10.1–10.2: a conservative lower bound on the SERVER's current time, used only to decide
 * when a v3 invoice may be SENT (the server rejects `sold_at > received_at + 60 s`). It never
 * extends selling authority and never reads the wall clock after a sample is taken.
 *
 * A sample is one server second `S` (second precision: license `server_time`, or the `/up` `Date`
 * header) bracketed by monotonic readings `m0` (sent) and `m1` (received). The server stamped `S`
 * somewhere inside `[m0, m1]`, so its true time at `m1` is at least `S`. At a later monotonic `m`
 * the bound is `S + age − drift`, with `age = m − m1` and `drift = age × 100 ppm`.
 *
 * A sample is refused when the round trip exceeds 5 s or `S` does not parse. It stops counting after
 * 6 h, on suspend/resume, and on restart (samples are memory-only). Wall-clock jumps have no effect.
 */

export interface ServerTimeSampleInput {
  /** ISO-8601 or IMF-fixdate (the HTTP `Date` header). */
  readonly serverTime: string
  readonly sentAtMono: number
  readonly receivedAtMono: number
}

export interface ServerTimeEstimatorOptions {
  readonly monotonicNow?: () => number
  readonly maxRoundTripMs?: number
  readonly maxAgeMs?: number
  readonly driftPpm?: number
}

interface AcceptedSample {
  readonly serverMs: number
  readonly receivedAtMono: number
}

export const SERVER_TIME_MAX_ROUND_TRIP_MS = 5_000
export const SERVER_TIME_MAX_AGE_MS = 6 * 3_600_000
export const SERVER_TIME_DRIFT_PPM = 100

export class ServerTimeEstimator {
  private sample: AcceptedSample | null = null
  private readonly listeners = new Set<() => void>()
  private readonly monotonicNow: () => number
  private readonly maxRoundTripMs: number
  private readonly maxAgeMs: number
  private readonly driftPpm: number

  constructor(options: ServerTimeEstimatorOptions = {}) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.maxRoundTripMs = options.maxRoundTripMs ?? SERVER_TIME_MAX_ROUND_TRIP_MS
    this.maxAgeMs = options.maxAgeMs ?? SERVER_TIME_MAX_AGE_MS
    this.driftPpm = options.driftPpm ?? SERVER_TIME_DRIFT_PPM
  }

  /** Returns whether the sample was accepted. A newer valid sample replaces an older one. */
  offer(input: ServerTimeSampleInput): boolean {
    const serverMs = Date.parse(input.serverTime)
    const roundTrip = input.receivedAtMono - input.sentAtMono

    if (
      !Number.isFinite(serverMs) ||
      !Number.isFinite(input.sentAtMono) ||
      !Number.isFinite(input.receivedAtMono) ||
      roundTrip < 0 ||
      roundTrip > this.maxRoundTripMs
    ) {
      return false
    }

    if (this.sample !== null && input.receivedAtMono <= this.sample.receivedAtMono) {
      return false
    }

    // Second precision: never let a sub-second fraction raise the bound.
    this.sample = {
      serverMs: Math.floor(serverMs / 1000) * 1000,
      receivedAtMono: input.receivedAtMono
    }

    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener is a wake hint; it can never affect the estimate.
      }
    }

    return true
  }

  /** Suspend/resume: monotonic time may not have advanced with real time. */
  invalidate(): void {
    this.sample = null
  }

  /** The lower bound (epoch ms) on the server's current time, or null when no usable sample exists. */
  lowerBound(): number | null {
    if (this.sample === null) {
      return null
    }

    const age = this.monotonicNow() - this.sample.receivedAtMono

    if (age < 0 || age > this.maxAgeMs) {
      return null
    }

    return this.sample.serverMs + age - age * this.driftPpm * 1e-6
  }

  onSample(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
