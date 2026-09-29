import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import {
  DeviceHeartbeatService,
  HEARTBEAT_MAX_TIMER_DELAY_MS,
  type DeviceHeartbeatResponse,
  type DeviceHeartbeatScheduler,
  type DeviceHeartbeatSessionContext
} from './deviceHeartbeat.service'
import {
  buildAccessFingerprint,
  createDeviceHeartbeat,
  type AccessFingerprintSources,
  type DeviceHeartbeatHandle
} from '../app/deviceHeartbeatWiring'

// The wiring module imports Electron; the service never does. Only the wiring tests at the bottom
// of this file touch it, and they inject their own power monitor.
vi.mock('electron', async () => {
  const events = await import('node:events')
  return { powerMonitor: new events.EventEmitter() }
})

const S = 1_000
const MIN = 60 * S
const H = 60 * MIN

interface Deferred {
  readonly resolve: (value: DeviceHeartbeatResponse) => void
  readonly reject: (error: unknown) => void
}

function error(fields: Partial<PublicAppError> & Pick<PublicAppError, 'category'>): PublicAppError {
  return publicAppErrorSchema.parse({ message: 'failure', retryable: false, ...fields })
}

const transportError = (): PublicAppError =>
  error({ category: 'transport', message: 'The desktop service refused the connection' })
const serverError = (): PublicAppError =>
  error({ category: 'transport', backendCode: 'SERVER_ERROR', retryable: true })
const rateLimited = (httpStatus: 429 | 503, retryAfterSeconds?: number): PublicAppError =>
  error({
    category: 'transport',
    backendCode: httpStatus === 429 ? 'TOO_MANY_REQUESTS' : 'SERVICE_UNAVAILABLE',
    retryable: true,
    httpStatus,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  })
const forbidden = (): PublicAppError =>
  error({ category: 'authorization', backendCode: 'DESKTOP_ACCESS_FORBIDDEN' })
const deviceMismatch = (): PublicAppError =>
  error({ category: 'authentication', backendCode: 'DESKTOP_TOKEN_DEVICE_MISMATCH' })
const sessionRevoked = (): PublicAppError =>
  error({ category: 'authentication', backendCode: 'SESSION_REVOKED' })

const heartbeatOk: DeviceHeartbeatResponse = {
  code: 'DEVICE_HEARTBEAT_RECORDED',
  data: {
    id: '1',
    device_uuid: '00000000-0000-4000-8000-000000000001',
    device_name: 'Till 1',
    platform: 'linux',
    status: 'active',
    last_seen_at: '2026-09-29T10:00:00Z',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
    some_future_field: { nested: true }
  }
}

interface Harness {
  readonly service: DeviceHeartbeatService
  readonly request: ReturnType<typeof vi.fn<(route: unknown) => Promise<DeviceHeartbeatResponse>>>
  readonly session: { current: DeviceHeartbeatSessionContext }
  readonly fingerprint: { current: string }
  readonly random: { current: number }
  readonly logs: string[]
  readonly timers: Map<number, { callback: () => void; dueAt: number; delay: number }>
  readonly now: number
  /** Moves the monotonic clock without firing timers (e.g. time passing while suspended). */
  jump(ms: number): void
  advance(ms: number): Promise<void>
  /** Fires due timers in order until `target`, then parks the clock at `target`. */
  advanceTo(target: number): Promise<void>
  flush(): Promise<void>
  timerCount(): number
  dueTimes(): number[]
  onlyDueAt(): number
  succeed(response?: DeviceHeartbeatResponse): Promise<void>
  fail(failure: unknown): Promise<void>
  pendingCount(): number
}

function createHarness(options: { random?: number } = {}): Harness {
  let now = 1_000_000
  let timerSequence = 0
  const timers = new Map<number, { callback: () => void; dueAt: number; delay: number }>()
  const scheduler: DeviceHeartbeatScheduler = {
    set(callback, delayMs) {
      const id = ++timerSequence
      timers.set(id, { callback, dueAt: now + delayMs, delay: delayMs })
      return id
    },
    clear(handle) {
      timers.delete(handle as number)
    }
  }
  const pending: Deferred[] = []
  const request = vi.fn<(route: unknown) => Promise<DeviceHeartbeatResponse>>(
    () =>
      new Promise<DeviceHeartbeatResponse>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  const session: { current: DeviceHeartbeatSessionContext } = {
    current: { authenticated: true, hasDeviceUuid: true, hasToken: true, sessionEpoch: 1 }
  }
  const fingerprint = { current: 'fingerprint-a' }
  const random = { current: options.random ?? 0.5 }
  const logs: string[] = []
  const service = new DeviceHeartbeatService({
    request,
    readSession: () => session.current,
    accessFingerprint: () => fingerprint.current,
    nowMs: () => now,
    random: () => random.current,
    scheduler,
    log: (line) => logs.push(line)
  })

  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  async function advanceTo(target: number): Promise<void> {
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0]

      if (!next || next[1].dueAt > target) {
        break
      }

      now = Math.max(now, next[1].dueAt)
      timers.delete(next[0])
      next[1].callback()
      await flush()
    }

    now = target
  }

  return {
    service,
    request,
    session,
    fingerprint,
    random,
    logs,
    timers,
    get now() {
      return now
    },
    jump(ms) {
      now += ms
    },
    advance: (ms) => advanceTo(now + ms),
    advanceTo,
    flush,
    timerCount: () => timers.size,
    dueTimes: () => [...timers.values()].map((timer) => timer.dueAt),
    onlyDueAt(): number {
      expect(timers.size).toBe(1)
      return [...timers.values()][0].dueAt
    },
    async succeed(response = heartbeatOk) {
      const next = pending.shift()
      expect(next).toBeDefined()
      next?.resolve(response)
      await flush()
    },
    async fail(failure) {
      const next = pending.shift()
      expect(next).toBeDefined()
      next?.reject(failure)
      await flush()
    },
    pendingCount: () => pending.length
  }
}

/** Starts a session, lets the immediate first beat go out and resolves it. */
async function startHealthy(harness: Harness): Promise<void> {
  harness.service.sync()
  await harness.advance(0)
  expect(harness.request).toHaveBeenCalledTimes(1)
  await harness.succeed()
}

describe('DeviceHeartbeatService', () => {
  describe('cadence', () => {
    it('sends the first beat immediately once the session is eligible, on the heartbeat route', async () => {
      const h = createHarness()

      h.service.sync()

      expect(h.onlyDueAt()).toBe(h.now)
      await h.advance(0)
      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.request).toHaveBeenCalledWith(DESKTOP_API_ROUTES.deviceHeartbeat)
      expect(h.timerCount()).toBe(0)
    })

    it.each([
      [0, 108 * S],
      [0.5, 120 * S],
      [0.999_999, 132 * S]
    ])('schedules the next beat 120 s ±10%% after success (random=%s)', async (random, gap) => {
      const h = createHarness({ random })

      await startHealthy(h)

      const due = h.onlyDueAt() - h.now
      expect(due).toBeGreaterThanOrEqual(108 * S)
      expect(due).toBeLessThanOrEqual(132 * S)
      expect(due).toBeCloseTo(gap, -1)
      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
    })

    it('keeps beating on the interval with exactly one timer', async () => {
      const h = createHarness()

      await startHealthy(h)
      for (let beat = 2; beat <= 4; beat += 1) {
        await h.advance(120 * S)
        expect(h.request).toHaveBeenCalledTimes(beat)
        expect(h.timerCount()).toBe(0)
        await h.succeed()
        expect(h.timerCount()).toBe(1)
      }
    })

    it('accepts a success whose resource has unknown or missing fields', async () => {
      const h = createHarness()

      h.service.sync()
      await h.advance(0)
      await h.succeed({ code: 'DEVICE_HEARTBEAT_RECORDED', data: { unexpected: true } })

      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
      expect(h.logs.some((line) => line.includes('resource=unrecognized'))).toBe(true)
    })
  })

  describe('backoff', () => {
    it('backs off 15→30→60→…→600 s, randomized within [0.5, 1] of the window', async () => {
      const expectedWindows = [15, 30, 60, 120, 240, 480, 600, 600].map((seconds) => seconds * S)

      for (const random of [0, 0.999_999]) {
        const h = createHarness({ random })
        h.service.sync()
        await h.advance(0)

        for (const [index, window] of expectedWindows.entries()) {
          await h.fail(transportError())
          const state = h.service.getState()
          const wait = h.onlyDueAt() - h.now

          expect(state.mode).toBe('backoff')
          expect(state.backoffLevel).toBe(index + 1)
          // The 30 s floor since the last start can lengthen a short window, never shorten it.
          expect(wait).toBeGreaterThanOrEqual(Math.min(window * 0.5, window))
          expect(wait).toBeLessThanOrEqual(Math.max(window, 30 * S))
          if (window * (0.5 + 0.5 * random) >= 30 * S) {
            expect(wait).toBeCloseTo(window * (0.5 + 0.5 * random), -1)
          }

          await h.advanceTo(h.onlyDueAt())
          expect(h.request).toHaveBeenCalledTimes(index + 2)
        }
      }
    })

    it('treats 5xx and 429/503 without a usable Retry-After as normal backoff', async () => {
      for (const failure of [serverError(), rateLimited(429), rateLimited(503)]) {
        const h = createHarness()
        h.service.sync()
        await h.advance(0)

        await h.fail(failure)

        expect(h.service.getState()).toMatchObject({
          mode: 'backoff',
          backoffLevel: 1,
          retryAfterUntil: null
        })
        expect(h.onlyDueAt() - h.now).toBeLessThanOrEqual(30 * S)
      }
    })

    it('returns to the normal cadence after a success', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())

      await h.succeed()

      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
      expect(h.onlyDueAt() - h.now).toBe(120 * S)
    })
  })

  describe('Retry-After', () => {
    it.each([429, 503] as const)('honors a %s Retry-After of 3 h in full', async (status) => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const sentAt = h.now

      await h.fail(rateLimited(status, 10_800))

      expect(h.service.getState()).toMatchObject({ mode: 'retry-after', backoffLevel: 1 })
      expect(h.onlyDueAt()).toBe(sentAt + 3 * H)

      // Nothing can pull it earlier: sync storms, nudges, access signals.
      for (let i = 0; i < 5; i += 1) h.service.sync()
      h.service.requestEarlyProbe('resume')
      h.service.requestEarlyProbe('connectivity-online')
      h.service.requestEarlyProbe('access-changed-verified')
      h.fingerprint.current = 'fingerprint-changed'
      h.service.onAccessSignal()
      h.service.suspend()
      h.service.resume()

      expect(h.onlyDueAt()).toBe(sentAt + 3 * H)
      await h.advanceTo(sentAt + 3 * H - 1)
      expect(h.request).toHaveBeenCalledTimes(1)
      await h.advanceTo(sentAt + 3 * H)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('keeps Retry-After across logout/login — a new session cannot bypass it', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const sentAt = h.now
      await h.fail(rateLimited(429, 3_600))

      h.session.current = { ...h.session.current, authenticated: false, hasToken: false }
      h.service.sync()
      expect(h.timerCount()).toBe(0)
      h.session.current = {
        authenticated: true,
        hasDeviceUuid: true,
        hasToken: true,
        sessionEpoch: 3
      }
      h.service.sync()

      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
      expect(h.onlyDueAt()).toBe(sentAt + H)
    })

    it('chains timers for a wait longer than setTimeout allows, and never fires early', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const sentAt = h.now
      const thirtyDays = 30 * 24 * 3_600

      await h.fail(rateLimited(503, thirtyDays))

      const [timer] = [...h.timers.values()]
      expect(timer.delay).toBe(HEARTBEAT_MAX_TIMER_DELAY_MS)
      await h.advanceTo(sentAt + HEARTBEAT_MAX_TIMER_DELAY_MS)
      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.timerCount()).toBe(1)
      await h.advanceTo(sentAt + thirtyDays * S - 1)
      expect(h.request).toHaveBeenCalledTimes(1)
      await h.advanceTo(sentAt + thirtyDays * S)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('escalates backoff from the Retry-After level when the next attempt fails', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(rateLimited(429, 60))
      await h.advanceTo(h.onlyDueAt())

      await h.fail(transportError())

      expect(h.service.getState()).toMatchObject({ mode: 'backoff', backoffLevel: 2 })
    })
  })

  describe('idempotence and nudges', () => {
    it('keeps exactly one timer across repeated sync() calls', async () => {
      const h = createHarness()

      for (let i = 0; i < 5; i += 1) h.service.sync()
      expect(h.timerCount()).toBe(1)
      await h.advance(0)
      expect(h.request).toHaveBeenCalledTimes(1)
      await h.succeed()

      const due = h.onlyDueAt()
      for (let i = 0; i < 5; i += 1) h.service.sync()
      expect(h.dueTimes()).toEqual([due])
    })

    it('ignores resume/connectivity nudges while backing off', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())
      await h.fail(transportError())
      const due = h.onlyDueAt()

      h.service.requestEarlyProbe('resume')
      h.service.requestEarlyProbe('connectivity-online')

      expect(h.dueTimes()).toEqual([due])
    })

    it('bounds active-mode nudges by lastStartAt + 30 s', async () => {
      const h = createHarness()
      await startHealthy(h)
      const startedAt = h.now

      await h.advance(10 * S)
      h.service.requestEarlyProbe('connectivity-online')
      expect(h.dueTimes()).toEqual([startedAt + 30 * S])

      h.service.requestEarlyProbe('resume')
      expect(h.dueTimes()).toEqual([startedAt + 30 * S])

      await h.advanceTo(startedAt + 30 * S - 1)
      expect(h.request).toHaveBeenCalledTimes(1)
      await h.advanceTo(startedAt + 30 * S)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('fires a nudge immediately once the 30 s floor has passed', async () => {
      const h = createHarness()
      await startHealthy(h)

      await h.advance(45 * S)
      h.service.requestEarlyProbe('connectivity-online')

      expect(h.dueTimes()).toEqual([h.now])
    })

    it('never sends a second request while one is in flight', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)

      h.service.sync()
      h.service.requestEarlyProbe('connectivity-online')
      h.service.resume()
      await h.advance(10 * MIN)

      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.timerCount()).toBe(0)
    })
  })

  describe('suspend and resume', () => {
    it('active: restores one timer and allows an early probe once the floor has passed', async () => {
      const h = createHarness()
      await startHealthy(h)
      const startedAt = h.now

      h.service.suspend()
      expect(h.timerCount()).toBe(0)
      h.jump(5 * S)
      h.service.resume()
      // Still inside the 30 s floor: the early probe waits for it.
      expect(h.dueTimes()).toEqual([startedAt + 30 * S])

      h.service.suspend()
      h.jump(60 * S)
      h.service.resume()
      expect(h.dueTimes()).toEqual([h.now])
    })

    it('backoff: keeps the deadline and does not probe early', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())
      await h.fail(transportError())
      const due = h.onlyDueAt()

      h.service.suspend()
      expect(h.timerCount()).toBe(0)
      h.jump(1 * S)
      h.service.resume()

      expect(h.dueTimes()).toEqual([due])
      expect(h.service.getState()).toMatchObject({ mode: 'backoff', backoffLevel: 2 })
    })

    it('retry-after: keeps the deadline and does not probe early', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(rateLimited(429, 7_200))
      const due = h.onlyDueAt()

      h.service.suspend()
      h.jump(10 * MIN)
      h.service.resume()

      expect(h.dueTimes()).toEqual([due])
    })

    it('denied: keeps the probe schedule', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(forbidden())
      const due = h.onlyDueAt()

      h.service.suspend()
      h.jump(1 * MIN)
      h.service.resume()

      expect(h.dueTimes()).toEqual([due])
      expect(h.service.getState().mode).toBe('denied')
    })

    it('in flight across suspend: no timer until it settles, and a transport failure does not escalate', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())
      await h.fail(transportError())
      await h.advanceTo(h.onlyDueAt())
      expect(h.service.getState()).toMatchObject({ backoffLevel: 2, inFlight: true })

      h.service.suspend()
      h.jump(1 * S)
      h.service.resume()
      expect(h.timerCount()).toBe(0)

      await h.fail(transportError())

      const state = h.service.getState()
      expect(state).toMatchObject({ mode: 'backoff', backoffLevel: 2 })
      // Rescheduled inside the level-2 window (30 s × [0.5, 1]).
      expect(h.onlyDueAt() - h.now).toBeLessThanOrEqual(30 * S)
    })

    it('in flight across suspend from active: retries at the floor without entering backoff', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const startedAt = h.now

      h.service.suspend()
      h.service.resume()
      await h.fail(transportError())

      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
      expect(h.dueTimes()).toEqual([startedAt + 30 * S])
    })

    it('in flight across suspend: a server answer still counts normally', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)

      h.service.suspend()
      h.service.resume()
      await h.fail(serverError())

      expect(h.service.getState()).toMatchObject({ mode: 'backoff', backoffLevel: 1 })
    })
  })

  describe('denied', () => {
    it.each([
      ['authorization', forbidden],
      ['device mismatch', deviceMismatch]
    ])('%s: probes again after 15 min ±10%%', async (_label, failure) => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)

      await h.fail(failure())

      expect(h.service.getState().mode).toBe('denied')
      const wait = h.onlyDueAt() - h.now
      expect(wait).toBeGreaterThanOrEqual(13.5 * MIN)
      expect(wait).toBeLessThanOrEqual(16.5 * MIN)
      await h.advanceTo(h.onlyDueAt() - 1)
      expect(h.request).toHaveBeenCalledTimes(1)
      await h.advance(1)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('treats an access publication with an unchanged fingerprint as a no-op', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(forbidden())
      const due = h.onlyDueAt()

      for (let i = 0; i < 5; i += 1) h.service.onAccessSignal()
      h.service.requestEarlyProbe('resume')
      h.service.requestEarlyProbe('connectivity-online')

      expect(h.dueTimes()).toEqual([due])
      await h.advance(10 * MIN)
      expect(h.request).toHaveBeenCalledTimes(1)
    })

    it('sends exactly one early probe for a verified change, bounded by lastStartAt + 30 s', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const startedAt = h.now
      await h.fail(forbidden())

      h.fingerprint.current = 'fingerprint-permissions-restored'
      h.service.onAccessSignal()
      h.service.onAccessSignal()

      expect(h.dueTimes()).toEqual([startedAt + 30 * S])
      await h.advanceTo(startedAt + 30 * S)
      expect(h.request).toHaveBeenCalledTimes(2)
      await h.fail(forbidden())

      // Denied again: the fingerprint recorded now is the changed one, so the same signal is inert.
      h.service.onAccessSignal()
      expect(h.onlyDueAt() - h.now).toBeGreaterThanOrEqual(13.5 * MIN)
      await h.advance(10 * MIN)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('fires a verified-change probe immediately when the floor has already passed', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(forbidden())
      await h.advance(2 * MIN)

      h.fingerprint.current = 'fingerprint-decision-changed'
      h.service.onAccessSignal()

      expect(h.dueTimes()).toEqual([h.now])
      await h.advance(0)
      await h.succeed()
      expect(h.service.getState()).toMatchObject({ mode: 'active', deniedProbeAt: null })
    })

    it('starts a fresh generation when the epoch changes, via sync() or an access signal', async () => {
      for (const trigger of ['sync', 'access'] as const) {
        const h = createHarness()
        h.service.sync()
        await h.advance(0)
        const startedAt = h.now
        await h.fail(forbidden())
        const generation = h.service.getState().generation

        h.session.current = { ...h.session.current, sessionEpoch: 2 }
        if (trigger === 'sync') h.service.sync()
        else h.service.onAccessSignal()

        expect(h.service.getState()).toMatchObject({
          mode: 'active',
          backoffLevel: 0,
          deniedProbeAt: null,
          generation: generation + 1
        })
        expect(h.dueTimes()).toEqual([startedAt + 30 * S])
      }
    })
  })

  describe('session lifecycle', () => {
    it('never sends without a token', async () => {
      const h = createHarness()
      h.session.current = { ...h.session.current, hasToken: false }

      h.service.sync()
      h.service.requestEarlyProbe('connectivity-online')
      h.service.resume()
      await h.advance(1 * H)

      expect(h.request).not.toHaveBeenCalled()
      expect(h.timerCount()).toBe(0)
    })

    it.each([
      ['token', { hasToken: false }],
      ['device uuid', { hasDeviceUuid: false }],
      ['authentication', { authenticated: false }]
    ])('re-checks eligibility at fire time (missing %s)', async (_label, change) => {
      const h = createHarness()
      await startHealthy(h)

      h.session.current = { ...h.session.current, ...change }
      await h.advance(5 * MIN)

      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.timerCount()).toBe(0)
      expect(h.service.getState().eligible).toBe(false)
    })

    it('never sends when the session cannot be read', async () => {
      const h = createHarness()
      await startHealthy(h)
      Object.defineProperty(h.session, 'current', {
        get() {
          throw new Error('database is locked')
        }
      })

      await h.advance(5 * MIN)

      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.timerCount()).toBe(0)
    })

    it('ignores a late response after logout/login and starts the new session fresh', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      const startedAt = h.now

      h.session.current = { ...h.session.current, authenticated: false, hasToken: false }
      h.service.sync()
      h.session.current = {
        authenticated: true,
        hasDeviceUuid: true,
        hasToken: true,
        sessionEpoch: 2
      }
      h.service.sync()
      expect(h.timerCount()).toBe(0)

      // The previous session's beat answers "forbidden" — it must not deny the new session.
      await h.fail(forbidden())

      expect(h.service.getState()).toMatchObject({ mode: 'active', backoffLevel: 0 })
      expect(h.logs.some((line) => line.includes('event=late-response-ignored'))).toBe(true)
      expect(h.dueTimes()).toEqual([startedAt + 30 * S])
      await h.advanceTo(startedAt + 30 * S)
      expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('schedules nothing further after a session-ending answer', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)

      await h.fail(sessionRevoked())

      expect(h.timerCount()).toBe(0)
      h.service.sync()
      h.service.requestEarlyProbe('connectivity-online')
      await h.advance(1 * H)
      expect(h.request).toHaveBeenCalledTimes(1)

      // The session hook ends the session; the next login starts a new generation.
      h.session.current = { ...h.session.current, authenticated: false, hasToken: false }
      h.service.sync()
      h.session.current = {
        ...h.session.current,
        authenticated: true,
        hasToken: true,
        sessionEpoch: 5
      }
      h.service.sync()
      expect(h.onlyDueAt()).toBe(h.now)
    })

    it('shutdown clears the timer and ignores late responses', async () => {
      const h = createHarness()
      await startHealthy(h)
      await h.advance(120 * S)
      expect(h.pendingCount()).toBe(1)

      h.service.shutdown()
      await h.fail(forbidden())
      h.service.sync()
      h.service.resume()
      h.service.onAccessSignal()
      await h.advance(1 * H)

      expect(h.timerCount()).toBe(0)
      expect(h.request).toHaveBeenCalledTimes(2)
      expect(h.service.getState()).toMatchObject({ stopped: true, mode: 'active' })
    })

    it('logs only categorical fields — never the token or a uuid', async () => {
      const h = createHarness()
      h.service.sync()
      await h.advance(0)
      await h.fail(forbidden())

      expect(h.logs.length).toBeGreaterThan(0)
      for (const line of h.logs) {
        expect(line.startsWith('[pos-heartbeat] event=')).toBe(true)
        expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
        expect(line).not.toContain('fingerprint-a')
      }
    })
  })
})

describe('buildAccessFingerprint', () => {
  function sources(overrides: Partial<AccessFingerprintSources> = {}): AccessFingerprintSources {
    return {
      sessionEpoch: () => 4,
      sessionBinding: () => ({
        isAuthenticated: true,
        userUuid: '11111111-1111-4111-8111-111111111111',
        userIsActive: true,
        companyUuid: '22222222-2222-4222-8222-222222222222',
        deviceUuid: '33333333-3333-4333-8333-333333333333',
        serverDeviceId: '44'
      }),
      deviceStatus: () => 'active',
      permissions: () => ['pos.sell', 'pos.invoice.upload'],
      decision: () => ({ allowed: true, reason: null, restrictionLevel: null }),
      ...overrides
    }
  }

  it('is a stable sha256 digest independent of permission order', () => {
    const base = buildAccessFingerprint(sources())

    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(
      buildAccessFingerprint(sources({ permissions: () => ['pos.invoice.upload', 'pos.sell'] }))
    ).toBe(base)
  })

  it.each([
    ['permission list', { permissions: () => ['pos.sell'] }],
    ['device status', { deviceStatus: () => 'blocked' }],
    ['session epoch', { sessionEpoch: () => 5 }],
    [
      'access decision',
      {
        decision: () => ({
          allowed: false,
          reason: 'permission-denied' as const,
          restrictionLevel: null
        })
      }
    ],
    ['session binding', { sessionBinding: () => null }]
  ])('changes when the %s changes', (_label, override) => {
    expect(buildAccessFingerprint(sources(override))).not.toBe(buildAccessFingerprint(sources()))
  })

  it('does not treat a connectivity-only denial as an access change', () => {
    expect(
      buildAccessFingerprint(
        sources({
          decision: () => ({
            allowed: false,
            reason: 'connectivity-unavailable' as const,
            restrictionLevel: null
          })
        })
      )
    ).toBe(buildAccessFingerprint(sources()))
  })
})

describe('createDeviceHeartbeat wiring', () => {
  interface WiringHarness {
    readonly handle: DeviceHeartbeatHandle
    readonly monitor: EventEmitter
    readonly listeners: Set<() => void>
    readonly timers: Map<number, { callback: () => void; dueAt: number }>
  }

  function wiring(): WiringHarness {
    const monitor = new EventEmitter()
    const listeners = new Set<() => void>()
    const now = 0
    const timers = new Map<number, { callback: () => void; dueAt: number }>()
    let sequence = 0
    const requestWithMeta = vi.fn(() => new Promise<never>(() => undefined))
    const permissions = { current: ['pos.sell'] }
    const handle = createDeviceHeartbeat({
      apiClient: { requestWithMeta } as never,
      session: {
        getContext: () => ({
          isAuthenticated: true,
          userUuid: 'u',
          userIsActive: true,
          companyUuid: 'c',
          deviceUuid: 'd',
          serverDeviceId: 's'
        })
      },
      sessionEpoch: { current: () => 1 },
      secrets: { getSecret: () => 'desktop-token' },
      deviceIdentity: { get: () => ({ deviceUuid: 'd' }) },
      permissions: { getPermissions: () => permissions.current },
      deviceRegistration: { get: () => ({ status: 'active' }) },
      commercialAccess: {
        evaluate: () => ({ allowed: true, reason: null, restrictionLevel: null })
      },
      accessPublisher: {
        onPublished: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      powerMonitor: monitor,
      log: () => undefined,
      timing: {
        nowMs: () => now,
        random: () => 0.5,
        scheduler: {
          set: (callback, delay) => {
            timers.set(++sequence, { callback, dueAt: now + delay })
            return sequence
          },
          clear: (id) => timers.delete(id as number)
        }
      }
    })

    return { handle, monitor, listeners, timers }
  }

  it('subscribes on start, beats immediately, and releases everything on dispose', () => {
    const w = wiring()

    w.handle.notifySessionChanged()
    expect(w.timers.size).toBe(0)

    w.handle.start()
    w.handle.start()
    expect(w.monitor.listenerCount('suspend')).toBe(1)
    expect(w.monitor.listenerCount('resume')).toBe(1)
    expect(w.listeners.size).toBe(1)
    expect(w.timers.size).toBe(1)

    w.monitor.emit('suspend')
    expect(w.timers.size).toBe(0)
    w.monitor.emit('resume')
    expect(w.timers.size).toBe(1)

    w.handle.dispose()
    expect(w.monitor.listenerCount('suspend')).toBe(0)
    expect(w.monitor.listenerCount('resume')).toBe(0)
    expect(w.listeners.size).toBe(0)
    expect(w.timers.size).toBe(0)
    expect(w.handle.service.getState().stopped).toBe(true)
  })

  it('nudges only on a transition into online', () => {
    const w = wiring()
    w.handle.start()
    const spy = vi.spyOn(w.handle.service, 'requestEarlyProbe')

    w.handle.notifyConnectivity({ status: 'checking' })
    w.handle.notifyConnectivity({ status: 'online' })
    w.handle.notifyConnectivity({ status: 'online' })
    w.handle.notifyConnectivity({ status: 'backend_unreachable' })
    w.handle.notifyConnectivity({ status: 'online' })

    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith('connectivity-online')
  })

  it('routes access publications to onAccessSignal', () => {
    const w = wiring()
    w.handle.start()
    const spy = vi.spyOn(w.handle.service, 'onAccessSignal')

    for (const listener of w.listeners) listener()

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
