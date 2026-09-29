import { describe, expect, it, vi } from 'vitest'
import type { ConnectivityStatus } from '@shared/contracts/connectivity.contract'
import { InMemoryAllocationDispatches } from '../testing/fakes/inMemoryAllocationDispatches'
import type { DispatchResolution } from './allocationAcquisition.service'
import { AllocationDispatchReconciler } from './allocationDispatchReconciler.service'

const owner = {
  companyUuid: '11111111-1111-4111-8111-111111111111',
  deviceUuid: '33333333-3333-4333-8333-333333333333'
}
const NOW = new Date('2026-01-01T02:00:00.000Z')

function seed(
  dispatches: InMemoryAllocationDispatches,
  key: string,
  attemptKey = 'attempt-1'
): void {
  dispatches.insertForClaimedAttempt({
    attemptKey,
    owner: { ...owner, warehouseUuid: 'w', actorUserUuid: 'u' },
    body: {
      idempotency_key: key.padEnd(64, '0'),
      allocation_payload_version: 2,
      items: [{ product_uuid: 'p', quantity: '1.000' }]
    },
    createdAt: NOW.toISOString()
  })
}

function build(options: {
  dispatches: InMemoryAllocationDispatches
  send?: (row: { idempotencyKey: string }) => Promise<DispatchResolution>
  status?: ConnectivityStatus
  owner?: typeof owner | null
  supported?: boolean
  preconditions?: boolean
  onRequestsResolved?: () => void
}): {
  reconciler: AllocationDispatchReconciler
  sendRecorded: ReturnType<typeof vi.fn>
  timers: Array<{ delay: number; fire: () => void; cleared: boolean }>
  onGrantsChanged: ReturnType<typeof vi.fn>
} {
  const timers: Array<{ delay: number; fire: () => void; cleared: boolean }> = []
  const sendRecorded = vi.fn(
    options.send ??
      (async (row: { idempotencyKey: string }) => {
        options.dispatches.markSending(row.idempotencyKey)
        options.dispatches.resolve(
          row.idempotencyKey,
          'granted',
          { kind: 'response' },
          NOW.toISOString()
        )
        return { kind: 'granted' } as DispatchResolution
      })
  )
  const onGrantsChanged = vi.fn()
  const reconciler = new AllocationDispatchReconciler({
    dispatches: options.dispatches,
    acquisition: { sendRecorded },
    connectivity: {
      getSnapshot: () =>
        ({ status: options.status ?? 'online' }) as ReturnType<
          ConstructorParameters<
            typeof AllocationDispatchReconciler
          >[0]['connectivity']['getSnapshot']
        >
    },
    apiClient: {
      assertRequestPreconditions: () => {
        if (options.preconditions === false) throw new Error('no token')
      }
    },
    owner: () => (options.owner === undefined ? owner : options.owner),
    allocationCapabilitySupported: () => options.supported ?? true,
    onGrantsChanged,
    onRequestsResolved: options.onRequestsResolved,
    schedule: (fire, delay) => {
      const timer = { delay, fire, cleared: false }
      timers.push(timer)
      return { clear: () => (timer.cleared = true) }
    },
    now: () => NOW,
    log: () => undefined
  })
  return { reconciler, sendRecorded, timers, onGrantsChanged }
}

describe('AllocationDispatchReconciler', () => {
  it('re-sends every outstanding recorded request once, oldest first, and reports new grants', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    seed(dispatches, 'b', 'attempt-2')
    const { reconciler, sendRecorded, onGrantsChanged, timers } = build({ dispatches })

    reconciler.requestRun()
    await reconciler.whenIdle()

    expect(sendRecorded.mock.calls.map(([row]) => row.idempotencyKey[0])).toEqual(['a', 'b'])
    expect(onGrantsChanged).toHaveBeenCalledTimes(1)
    expect(dispatches.listOutstanding(owner)).toHaveLength(0)
    expect(timers).toHaveLength(0)
  })

  it('announces resolved requests so a status view re-reads them, and stays quiet otherwise', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    const onRequestsResolved = vi.fn()
    const resolving = build({ dispatches, onRequestsResolved })
    resolving.reconciler.requestRun()
    await resolving.reconciler.whenIdle()
    expect(onRequestsResolved).toHaveBeenCalledTimes(1)

    const pending = new InMemoryAllocationDispatches()
    seed(pending, 'b')
    const quiet = vi.fn()
    const unresolved = build({
      dispatches: pending,
      onRequestsResolved: quiet,
      send: async () => ({ kind: 'unresolved', code: 'allocation-acquisition-unresolved' })
    })
    unresolved.reconciler.requestRun()
    await unresolved.reconciler.whenIdle()
    expect(quiet).not.toHaveBeenCalled()
  })

  it('never sends without an owner, connectivity, allocation capability or request credentials', async () => {
    for (const variant of [
      { owner: null },
      { status: 'offline' as const },
      { status: 'checking' as const },
      { supported: false },
      { preconditions: false }
    ]) {
      const dispatches = new InMemoryAllocationDispatches()
      seed(dispatches, 'a')
      const { reconciler, sendRecorded } = build({ dispatches, ...variant })
      reconciler.requestRun()
      await reconciler.whenIdle()
      expect(sendRecorded).not.toHaveBeenCalled()
      expect(dispatches.listOutstanding(owner)).toHaveLength(1)
    }
  })

  it('skips a row until its server Retry-After and schedules exactly one wake-up for it', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    dispatches.recordAmbiguous(
      'a'.padEnd(64, '0'),
      { kind: 'ambiguous' },
      new Date(NOW.getTime() + 10 * 60_000).toISOString()
    )
    const { reconciler, sendRecorded, timers } = build({ dispatches })

    reconciler.requestRun()
    await reconciler.whenIdle()

    expect(sendRecorded).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(10 * 60_000)
  })

  it('backs off while requests stay unresolved, doubling up to the cap', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    const { reconciler, timers } = build({
      dispatches,
      send: async () => ({ kind: 'unresolved', code: 'allocation-acquisition-unresolved' })
    })

    const delays: number[] = []
    for (let run = 0; run < 7; run += 1) {
      reconciler.requestRun()
      await reconciler.whenIdle()
      delays.push(timers[timers.length - 1].delay)
    }

    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000])
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1)
  })

  it('coalesces overlapping triggers into one run plus one rerun', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    let release: () => void = () => undefined
    const { reconciler, sendRecorded } = build({
      dispatches,
      send: (row) =>
        new Promise<DispatchResolution>((resolve) => {
          release = () => {
            dispatches.markSending(row.idempotencyKey)
            dispatches.resolve(
              row.idempotencyKey,
              'granted',
              { kind: 'response' },
              NOW.toISOString()
            )
            resolve({ kind: 'granted' })
          }
        })
    })

    reconciler.requestRun()
    reconciler.requestRun()
    reconciler.requestRun()
    release()
    await reconciler.whenIdle()
    await reconciler.whenIdle()

    expect(sendRecorded).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels the pending wake-up and ignores later triggers', async () => {
    const dispatches = new InMemoryAllocationDispatches()
    seed(dispatches, 'a')
    const { reconciler, timers, sendRecorded } = build({
      dispatches,
      send: async () => ({ kind: 'unresolved', code: 'allocation-acquisition-unresolved' })
    })
    reconciler.requestRun()
    await reconciler.whenIdle()
    reconciler.stop()
    reconciler.requestRun()
    await reconciler.whenIdle()

    expect(timers.every((timer) => timer.cleared)).toBe(true)
    expect(sendRecorded).toHaveBeenCalledTimes(1)
  })
})
