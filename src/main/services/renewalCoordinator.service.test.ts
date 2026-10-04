import { describe, expect, it } from 'vitest'
import type { LicenseStatus } from '@shared/contracts/license.contract'
import {
  CATALOG_REFRESH_CADENCE_MS,
  RenewalCoordinator,
  type RenewalWindow
} from './renewalCoordinator.service'
import { OwnerChangedError, type RenewalOwner } from './renewalOwner'

const HOUR = 3_600_000
const OWNER: RenewalOwner = {
  sessionEpoch: 1,
  userUuid: 'user',
  userIsActive: true,
  companyUuid: 'company',
  deviceUuid: 'device',
  serverDeviceId: 'server-device',
  branchUuid: 'branch',
  warehouseUuid: 'warehouse'
}

function status(canSell = true): LicenseStatus {
  return { canSell } as unknown as LicenseStatus
}

/** A deterministic clock + single-timer scheduler; `advance` fires due timers in order. */
function world(options: {
  windowHours: number
  cap?: number
  validate?: (n: number) => Promise<LicenseStatus>
}): {
  coordinator: RenewalCoordinator
  validations: () => number
  timers: Array<{ at: number; fn: () => void; id: number }>
  setOwner: (o: RenewalOwner | null) => RenewalOwner | null
  now: () => number
  advance: (ms: number) => Promise<void>
  flush: () => Promise<void>
} {
  let now = Date.parse('2026-09-30T00:00:00Z')
  let authorityWindow: RenewalWindow | null = null
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  let validations = 0
  let owner: RenewalOwner | null = OWNER

  const issue = (): void => {
    const start = now
    const end = Math.min(now + options.windowHours * HOUR, options.cap ?? Number.POSITIVE_INFINITY)
    authorityWindow = { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
  }

  const coordinator = new RenewalCoordinator({
    license: {
      validate: async () => {
        validations += 1
        if (options.validate) {
          const result = await options.validate(validations)
          if (result.canSell) issue()
          return result
        }
        issue()
        return status()
      }
    },
    owner: () => owner,
    authorityWindow: () => authorityWindow,
    catalogWindow: () => null,
    wallNow: () => now,
    monotonicNow: () => now,
    random: () => 0.5,
    scheduler: {
      set: (fn, delay) => {
        const id = nextId++
        timers.push({ at: now + delay, fn, id })
        return id
      },
      clear: (id) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      }
    }
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  return {
    coordinator,
    validations: () => validations,
    timers,
    setOwner: (o: RenewalOwner | null) => (owner = o),
    now: () => now,
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > target) break
        now = next.at
        timers.shift()
        next.fn()
        await flush()
      }
      now = target
      await flush()
    },
    flush
  }
}

describe('RenewalCoordinator — bounded proactive renewal (Rev 4 §7.3)', () => {
  it('a 2-hour policy window renews about once an hour — no loop', async () => {
    const w = world({ windowHours: 2 })
    await w.coordinator.renew('start')
    expect(w.validations()).toBe(1)

    await w.advance(5 * HOUR)

    // lead = min(24h, 2h/2) = 1h → one renewal per hour: about 5 in 5 hours, never a tight loop.
    expect(w.validations()).toBeGreaterThanOrEqual(5)
    expect(w.validations()).toBeLessThanOrEqual(6)
  })

  it('a 72-hour window renews once per ~48 hours (lead capped at 24h)', async () => {
    const w = world({ windowHours: 72 })
    await w.coordinator.renew('start')
    await w.advance(47 * HOUR)
    expect(w.validations()).toBe(1)
    await w.advance(2 * HOUR)
    expect(w.validations()).toBe(2)
  })

  it('stops proactive renewal when the deadline cannot move (hard cap) — no loop at the boundary', async () => {
    const cap = Date.parse('2026-09-30T00:00:00Z') + 3 * HOUR
    const w = world({ windowHours: 72, cap })
    await w.coordinator.renew('start')
    await w.advance(2 * HOUR) // past D − lead: renews once, D stays at the cap
    const afterFirst = w.validations()
    await w.advance(10 * HOUR)

    expect(afterFirst).toBe(2)
    expect(w.validations()).toBe(2)
    expect(w.coordinator.describe().timerArmed).toBe(false)
  })

  it('backs off on a transient failure, honouring Retry-After, without touching the held authority', async () => {
    const w = world({
      windowHours: 2,
      validate: async (n) => {
        if (n === 2) {
          throw { category: 'transport', retryAfterSeconds: 1200, retryable: true }
        }
        return status()
      }
    })
    await w.coordinator.renew('start')
    await w.advance(HOUR) // fires, fails
    expect(w.validations()).toBe(2)
    const plan = w.coordinator.describe().plan
    expect(plan).not.toBeNull()
    expect((plan as { fireAt: number }).fireAt - w.now()).toBeGreaterThanOrEqual(1200_000)
  })

  it('an access denial pauses proactive renewal until the owner changes', async () => {
    const w = world({ windowHours: 2, validate: async () => status(false) })
    const outcome = await w.coordinator.renew('start')
    expect(outcome.kind).toBe('denied')
    expect(w.coordinator.describe().timerArmed).toBe(false)
    await w.advance(10 * HOUR)
    expect(w.validations()).toBe(1)

    w.setOwner({ ...OWNER, sessionEpoch: 2 })
    w.coordinator.onSessionChanged()
    await w.flush()
    expect(w.validations()).toBe(2)
  })

  it('an authentication failure is a denial, not a retry loop', async () => {
    const w = world({
      windowHours: 2,
      validate: async () => {
        throw { category: 'authentication', retryable: false }
      }
    })
    const outcome = await w.coordinator.licenseLeg('checkout')
    expect(outcome.kind).toBe('denied')
    await w.advance(10 * HOUR)
    expect(w.validations()).toBe(1)
  })
})

describe('RenewalCoordinator — single-flight and ownership (Rev 4 §7.1)', () => {
  it('concurrent legs for the same owner share one validation', async () => {
    let release: () => void = () => undefined
    const w = world({
      windowHours: 2,
      validate: () => new Promise((resolve) => (release = () => resolve(status())))
    })
    const a = w.coordinator.licenseLeg('manual')
    const b = w.coordinator.licenseLeg('timer')
    const c = w.coordinator.licenseLeg('online')
    release()
    await Promise.all([a, b, c])
    expect(w.validations()).toBe(1)
  })

  it('a leg for a different owner waits and then runs its own validation', async () => {
    let release: () => void = () => undefined
    let calls = 0
    const w = world({
      windowHours: 2,
      validate: () => {
        calls += 1
        return calls === 1
          ? new Promise((resolve) => (release = () => resolve(status())))
          : Promise.resolve(status())
      }
    })
    const first = w.coordinator.licenseLeg('manual')
    w.setOwner({ ...OWNER, userUuid: 'other', sessionEpoch: 2 })
    const second = w.coordinator.licenseLeg('session')
    release()
    await Promise.all([first, second])
    expect(w.validations()).toBe(2)
  })

  it('classifies an owner change in flight and writes nothing itself', async () => {
    const w = world({
      windowHours: 2,
      validate: async () => {
        throw new OwnerChangedError()
      }
    })
    expect((await w.coordinator.licenseLeg('checkout')).kind).toBe('owner-changed')
  })

  it('ignores a same-owner session notification (e.g. /auth/me during a refresh)', async () => {
    const w = world({ windowHours: 2 })
    w.coordinator.start()
    await w.flush()
    const before = w.validations()
    w.coordinator.onSessionChanged()
    w.coordinator.onSessionChanged()
    await w.flush()
    expect(w.validations()).toBe(before)
  })

  it('does nothing without a signed-in owner', async () => {
    const w = world({ windowHours: 2 })
    w.setOwner(null)
    expect((await w.coordinator.licenseLeg('timer')).kind).toBe('no-owner')
    expect(w.validations()).toBe(0)
  })

  it('a failed catalog leg keeps the renewed license and retries on an idle draft without re-validating (R3)', async () => {
    let mono = 0
    let validations = 0
    let catalogAttempts = 0
    const coordinator = new RenewalCoordinator({
      license: {
        validate: async () => {
          validations += 1
          return status()
        }
      },
      owner: () => OWNER,
      authorityWindow: () => null,
      catalogWindow: () => null,
      catalogLeg: async () => {
        catalogAttempts += 1
        if (catalogAttempts === 1) throw new Error('bootstrap 503')
      },
      wallNow: () => mono,
      monotonicNow: () => mono,
      random: () => 0.5,
      scheduler: { set: () => 1, clear: () => undefined }
    })

    const outcome = await coordinator.renew('manual')
    expect(outcome.kind).toBe('renewed')
    expect([validations, catalogAttempts]).toEqual([1, 1])
    expect(coordinator.hasPendingCatalog()).toBe(true)

    coordinator.onDraftIdle() // inside the 30 s backoff: nothing
    await Promise.resolve()
    expect(catalogAttempts).toBe(1)

    mono += 31_000
    coordinator.onDraftIdle()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect([validations, catalogAttempts]).toEqual([1, 2])
    expect(coordinator.hasPendingCatalog()).toBe(false)
  })

  it('a deferred install with no window and no further idle report is retried by its own backoff timer', async () => {
    let mono = 1_000_000
    let catalogAttempts = 0
    const timers: Array<{ at: number; fn: () => void; id: number }> = []
    let nextId = 1
    const coordinator = new RenewalCoordinator({
      license: { validate: async () => status() },
      owner: () => OWNER,
      authorityWindow: () => null,
      catalogWindow: () => null,
      catalogLeg: async () => {
        catalogAttempts += 1
        if (catalogAttempts === 1)
          throw Object.assign(new Error('deferred'), { code: 'install-deferred' })
      },
      wallNow: () => mono,
      monotonicNow: () => mono,
      random: () => 0.5,
      scheduler: {
        set: (fn, delay) => {
          const id = nextId++
          timers.push({ at: mono + delay, fn, id })
          return id
        },
        clear: (id) => {
          const i = timers.findIndex((t) => t.id === id)
          if (i >= 0) timers.splice(i, 1)
        }
      }
    })

    await coordinator.renew('manual')
    expect(coordinator.hasPendingCatalog()).toBe(true)
    // No authority or catalog window: the proactive schedule arms nothing; only the retry timer exists.
    expect(timers).toHaveLength(1)
    expect(timers[0].at - mono).toBe(30_000)

    mono = timers[0].at
    timers.shift()?.fn()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(catalogAttempts).toBe(2)
    expect(coordinator.hasPendingCatalog()).toBe(false)
    expect(timers).toHaveLength(0)

    coordinator.stop()
  })

  it('with a distant (no-limit) deadline, an online till still refreshes its catalog about daily', async () => {
    const NO_DEADLINE = '2038-01-19T00:00:00.000Z'
    let now = Date.parse('2026-10-01T00:00:00Z')
    let catalogStart = now
    let validations = 0
    let catalogLegs = 0
    const timers: Array<{ at: number; fn: () => void; id: number }> = []
    let nextId = 1
    const coordinator = new RenewalCoordinator({
      license: {
        validate: async () => {
          validations += 1
          return status()
        }
      },
      owner: () => OWNER,
      // Offline limits off: neither window moves when renewed, so the no-progress guard engages.
      authorityWindow: () => ({ start: new Date(now).toISOString(), end: NO_DEADLINE }),
      catalogWindow: () => ({ start: new Date(catalogStart).toISOString(), end: NO_DEADLINE }),
      catalogLeg: async () => {
        catalogLegs += 1
        catalogStart = now
      },
      wallNow: () => now,
      monotonicNow: () => now,
      random: () => 0.5,
      scheduler: {
        set: (fn, delay) => {
          const id = nextId++
          timers.push({ at: now + delay, fn, id })
          return id
        },
        clear: (handle) => {
          const index = timers.findIndex((t) => t.id === handle)
          if (index >= 0) timers.splice(index, 1)
        }
      }
    })

    await coordinator.renew('start')
    expect(coordinator.describe().noProgressDeadline).toBe(Date.parse(NO_DEADLINE))
    const plan = coordinator.describe().plan
    expect(plan?.fireAt).toBe(catalogStart + CATALOG_REFRESH_CADENCE_MS)

    // Three simulated days. Timers sleep at most 6 h and re-plan on waking; the catalog is
    // refreshed once per cadence, never in a loop.
    const end = now + 3 * CATALOG_REFRESH_CADENCE_MS + 3_600_000
    for (let fired = 0; fired < 50 && now < end; fired += 1) {
      const next = timers.sort((a, b) => a.at - b.at).shift()
      expect(next).toBeDefined()
      now = next!.at
      next!.fn()
      for (let i = 0; i < 50; i += 1) await Promise.resolve()
    }
    expect(catalogLegs).toBe(3)
    expect(validations).toBe(4)
    expect(coordinator.describe().plan?.fireAt).toBe(catalogStart + CATALOG_REFRESH_CADENCE_MS)
  })
})
