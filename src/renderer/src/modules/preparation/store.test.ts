// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PreparationReadiness } from '@shared/contracts/preparation.contract'
import { usePreparationStore } from './store'

/*
 * CP4 — the renderer store.
 *
 * The property worth pinning here is a *negative* one: the renderer never computes the countdown.
 * §8.5 forbids re-deriving it from the moment the screen opened, and §13 lists that as a stop
 * condition — a renderer clock is exactly how it would happen by accident. So these tests assert
 * that the displayed number is whatever main said, unchanged, and that nothing in the store
 * recomputes or advances it.
 */

function readiness(overrides: Partial<PreparationReadiness['time']> = {}): PreparationReadiness {
  return {
    available: true,
    time: {
      state: 'counting_down',
      preparedAt: '2026-09-09T10:00:00Z',
      requestedDurationSeconds: 259_200,
      originalResult: 'ready_72h',
      effectiveReadyUntil: '2026-09-12T10:00:00Z',
      remainingSeconds: 70 * 3600,
      limitingReason: 'required_window',
      tiedLimitingReasons: ['required_window'],
      newlyObservedRestriction: null,
      lastTrustedObservationAt: '2026-09-09T10:00:00Z',
      ...overrides
    },
    quantity: { state: 'full', products: [] },
    blockedProducts: [],
    unresolvedOperations: []
  }
}

function installPosApi(overrides: {
  readonly getReadiness?: () => Promise<unknown>
  readonly runCycle?: () => Promise<unknown>
}): void {
  Object.defineProperty(window, 'posApi', {
    configurable: true,
    value: {
      preparation: {
        getReadiness: overrides.getReadiness ?? (async () => ({ ok: true, data: readiness() })),
        runCycle:
          overrides.runCycle ??
          (async () => ({ ok: true, data: { outcome: 'applied', reason: null } }))
      }
    }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('the preparation store', () => {
  it('displays the remaining time main reported, without recomputing it', async () => {
    installPosApi({})
    const store = usePreparationStore()

    await store.refresh()

    expect(store.remainingSeconds).toBe(70 * 3600)
    expect(store.timeState).toBe('counting_down')
    // The original window is carried as history alongside the live number, never merged with it.
    expect(store.readiness?.time.requestedDurationSeconds).toBe(259_200)
    expect(store.readiness?.time.originalResult).toBe('ready_72h')
  })

  it('does not advance the countdown as time passes locally', async () => {
    // The number changes only when main is asked again. A local timer that decremented it would be
    // a renderer clock by another name.
    vi.useFakeTimers()
    installPosApi({})
    const store = usePreparationStore()

    await store.refresh()
    const initial = store.remainingSeconds

    vi.advanceTimersByTime(60_000)

    expect(store.remainingSeconds).toBe(initial)
    vi.useRealTimers()
  })

  it('claims the full window only when main says so', async () => {
    installPosApi({ getReadiness: async () => ({ ok: true, data: readiness() }) })
    const countingDown = usePreparationStore()
    await countingDown.refresh()

    expect(countingDown.showsFullWindowClaim).toBe(false)

    setActivePinia(createPinia())
    installPosApi({
      getReadiness: async () => ({
        ok: true,
        data: readiness({ state: 'ready_full_window', remainingSeconds: 259_200 })
      })
    })
    const full = usePreparationStore()
    await full.refresh()

    expect(full.showsFullWindowClaim).toBe(true)
  })

  it('never renders an unresolved operation as a successful preparation', async () => {
    // §8.6: an operation that is ambiguous or awaiting replay is reported as unresolved, with its
    // pending action — never as a success.
    installPosApi({
      getReadiness: async () => ({
        ok: true,
        data: {
          ...readiness(),
          available: false,
          time: { ...readiness().time, state: 'not_prepared' as const },
          unresolvedOperations: [
            { operationUuid: 'operation', state: 'discovered_pending_replay', productCount: 3 }
          ]
        }
      })
    })
    const store = usePreparationStore()

    await store.refresh()

    expect(store.hasUnresolvedOperations).toBe(true)
    expect(store.isAvailable).toBe(false)
    expect(store.timeState).toBe('not_prepared')
  })

  it('surfaces a backend error through its stable code rather than a raw message', async () => {
    installPosApi({
      getReadiness: async () => ({
        ok: false,
        error: {
          category: 'authorization',
          message: 'Raw internal detail that must not be shown',
          backendCode: 'PERMISSION_DENIED',
          retryable: false
        }
      })
    })
    const store = usePreparationStore()

    await store.refresh()

    expect(store.error).not.toBeNull()
    expect(store.error).not.toContain('Raw internal detail')
  })

  it('ignores a second cycle request while one is already running', async () => {
    let started = 0
    installPosApi({
      runCycle: async () => {
        started += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { ok: true, data: { outcome: 'applied', reason: null } }
      }
    })
    const store = usePreparationStore()

    await Promise.all([store.runCycle(), store.runCycle()])

    // Main would refuse a duplicate anyway (§5.6), but not spamming it is the honest client half.
    expect(started).toBe(1)
  })

  it('refreshes after a cycle so the displayed state is never the pre-cycle one', async () => {
    let reads = 0
    installPosApi({
      getReadiness: async () => {
        reads += 1
        return { ok: true, data: readiness() }
      }
    })
    const store = usePreparationStore()

    await store.runCycle()

    expect(reads).toBe(1)
    expect(store.lastCycle).toEqual({ outcome: 'applied', reason: null })
  })
})
